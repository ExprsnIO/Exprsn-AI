# Changelog

## 1.7.0 (in progress)

### Agents, tools, skills and workflows in chat (Sprint 40a, B-4001 to B-4009)

- Migration `042_chat_invocation`: `chat_invocations` (the cards), `messages.turn` and `invocation_id`,
  `conversations.skills`, `profiles.agents` and `profiles.skills`. Settings `CHAT_CARD_TTL_SECONDS` (1 day),
  `CHAT_AGENT_WAIT_SECONDS` (45) and `CHAT_AGENT_CONTEXT_TURNS` (8).
- What a conversation may call (B-4001): `GET /api/conversations/:id/capabilities` lists the published agents,
  tools (with input schema and side-effect class), skills and workflows the caller may use there, within the
  conversation's ceiling and the profile's lists; what is hidden carries its reason, and calling it by name is
  refused the same way.
- A person calls a tool (B-4002): `/tool` in the composer, with a form from the tool's input schema or free text
  the profile's model turns into arguments, goes through the dispatcher and the tool-call guardrail; the call and
  its result join the conversation as a tool turn the model sees next. A call a rule holds shows as held and runs
  only when a reviewer approves it in the Flags queue.
- Write and destructive tools in chat (B-4003): offered to the model and callable by the person, behind an in-chat
  approval card; a write tool runs on the owner's approval, a destructive or always-confirm tool a rule flagged also
  needs the guardrail's approver; denied and expired cards are recorded and leave a turn that says so.
- `@agent` (B-4004): a run bound to the conversation with the message and, when the person allows it, the recent
  turns within the agent's label; its steps stream into a run card; its answer is a turn attributed to the agent;
  Runs shows it with a link back to the conversation; cancel from the chat stops it.
- `+skill` (B-4005): a published skill's instructions join the system prompt, sticky or for one turn, as chips;
  the profile's `skills` list restricts which apply; removing a skill leaves its instructions out of the very next
  turn.
- The model hands a turn to an agent (B-4006): agents on the profile's `agents` list are offered as `agent:<name>`
  tools and run under the chat turn's chain within its depth and budgets; the answer waits a while for the run,
  then adopts it as a turn of its own.
- `/workflow` (B-4009): a published workflow started from a conversation, its approvals as cards in the
  conversation (and the calls held in its chain, decided from the root), its outcome a turn.
- Console (B-4007, B-4008): the Chat board and the live Chat screen get the `/`, `@` and `+` pickers
  (keyboard-first), tool, approval and run cards, skill chips and their states; the Runs screen links a chat-started
  run back to its conversation. `e2e/tests/chat.spec.ts` with axe-core; the chat and runs accessibility and reflow
  sweeps pass.

### Dataset import, knowledge sets and the Import screen (Sprint 40b, B-3804 to B-3807)

- Migration `042b_dataset_import`: `import_jobs.result`, `rows_total`, `sample_rows`, `dataset_id`, `kb_id`, `source_id`,
  `classifier_id`, `eval_set`; `training_datasets.import_id`.
- Dataset import (B-3804): a dataset from a confirmed repository (CKAN with its datastore, DCAT-AP, SDMX, OpenML,
  InvenioRDM, a Hugging Face compatible hub; Kaggle's archives refused) through the same wizard as a model: the select
  step lists configurations, splits and resources and previews the schema with the columns the PII detectors flag;
  the review step checks format, quota (a sample above it), licence with the legal-review exception, label, the
  destination's permission and the columns; the `imports.dataset` job streams rows page by page (CSV, TSV, JSON, JSON
  Lines; the CKAN datastore, Socrata, e-Stat and OGD APIs by offset and limit; SDMX-CSV) into staging and registers a
  training version (`source_kind: import`, scrubbed, sealed and hashed as an inline one), an eval set, a knowledge set
  or the sealed rows, with a signed manifest. `GET /api/imports/repositories/:id/dataset`, `POST /api/imports/dataset-plan`,
  `POST /api/imports/datasets`; setting `IMPORT_DATASET_MAX_ROWS`.
- Knowledge sets (B-3805): `knowledge_sources.kind = dataset` with a column mapping, grouping, PII columns dropped,
  citations back to the row and a refresh schedule that follows the publisher (`weekly` and `monthly` join the
  schedules); a refresh re-reads the source and swaps changed rows only.
- Eval sets and imported engines (B-3806): rows into a classifier eval set with the minimum-sample warnings, a new or
  existing classifier set on them and trained or evaluated at once; `POST /api/imports` with `target: classifiers`
  registers a text-classification model as a classifier with the `imported` engine, scored by the classifier worker
  (`CLASSIFIER_WORKER_URL`, `CLASSIFIER_WORKER_TIMEOUT_MS`).
- Console (B-3807): the Import screen is live (wizard, Imports queue with cancel, retry and logs, Repositories with
  dual control), with entry points on Models, Training, Classifiers and Knowledge; `e2e/tests/import.spec.ts` with
  axe-core. Prototype boards: three more Import states, the dataset source on Knowledge, the imported engine on
  Classifiers, an imported version on Training.

## 1.6.0

### Model servers beyond Ollama: Apple Foundation Models, MLX and llama.cpp (Sprint 35a, B-4301 to B-4307)

- The gateway client behind an interface (B-4301): `ModelServer` (`server/src/gateway/server.ts`) with `version`,
  `models`, `loaded`, `show`, `load`, `unload`, `pull`, `delete`, `chat` and `embed`; `OllamaClient` implements it
  unchanged and no gateway test changed. What a server cannot do throws `Unsupported`, which the gateway, placements
  and the catalogue skip: nothing resident is reported, loads and unloads are recorded as `unsupported` instance
  events, pulls onto a mixed pool and rolling upgrades skip the server.
- `kind: openai` instances (B-4302): migration `037_model_servers` (`instances.kind` defaulting to `ollama`,
  `socket_path`, `token_ref`, `token_tenant`, `token_owner`). A Chat Completions server on a URL (the egress check and
  mutual TLS as for Ollama) or a Unix socket (`fm serve --socket`), with an optional bearer token stored in the
  caller's vault (`model-servers/<id>#token`) or given as a vault reference, resolved as the person who saved it.
  Health from `/health` or `/v1/models`; models from `/v1/models` (Apple's `pcc` listed but unavailable is not
  offered); llama.cpp's `/props` context length. The new `instance.probe` job (`POST /api/admin/instances/:id/probe`,
  run at registration) records whether tool calls and JSON schema output work; what the server reported is in
  `settings.reported`. `GET /api/admin/model-servers` (`models:manage`) is the import picker's list. Audited
  `instance.created {kind, socket, token}`, `instance.probe.started`.
- Chat Completions mapped onto the gateway's chat (B-4303, `server/src/gateway/openai-server.ts`): messages, the
  system prompt, tools and tool calls (ids kept, results paired with their calls), streamed deltas and reasoning,
  `response_format` from a JSON schema (`format` on the gateway's chat request, also passed to Ollama), stop,
  temperature, max tokens and usage (estimated when the server reports none). Ollama-only options are dropped and
  noted once as a `dropped` instance event. The tool loop, guardrails, labels and metering are unchanged.
  `server/test/fake-openai-server.ts` stands in for `fm serve`, `mlx_lm.server` and `llama-server` (TCP or socket).
- Catalogue entries without a pull (B-4304): `POST /api/admin/models {serverInstanceId, serverModel}` registers a
  listed model with `format: server`, no expected digest, `source: server:<instance>/<id>` (`models.server_instance_id`,
  `server_model`), placed warm on the instance's pool. Licence, conformance (run on that instance; the tool-calling
  test always runs and grants `tools`), label and dual-control approval apply; placements on a pool with such a
  server are warm only; retiring deletes nothing on the server.
- Embeddings and guard models (B-4305): a server that answers `/v1/embeddings` serves embedding models; one that
  refuses is remembered and the request goes to another instance with the model, such as an Ollama pool, with no
  change to the knowledge or guardrail code.
- Docs (B-4306): `docs/deploy.md` on `fm serve --socket` under launchd beside Ollama on a `metal` pool, with
  `mlx_lm.server` and `llama-server` as alternatives; `docs/security.md` on what the digest check cannot cover for
  server-held models; `docs/api.md` and `docs/openapi.json`.
- Console (B-4307): the Models screen gets Model servers (a drawer of the registered servers with what they report,
  Register model server with the kind, the socket path or URL and the token, and Probe again), Request import gets
  "Held by a model server" (the import picker of server-held models, unavailable ones disabled with the reason), and
  a held model's inspector, approval and card say "held by the server, no digest" with the capabilities the server
  reported. The prototype board first, then the live screen; `e2e/tests/models.spec.ts` registers an `fm serve`
  socket (the e2e server starts the fake on one) and approves its model with axe-core and 320 px reflow checks. The
  Pools screen's Load model offers Ollama instances only.

### Overview and Jobs and queues live (Sprint 35b, B-4202, B-4203, with B-4207)

- The Overview screen is live, first in the Admin group (Q3): open alerts computed from the existing watches (an
  instance behind the schema or not answering, the backup RPO, zone drift in the cluster, platform certificates and the
  tenant's own certificates expiring within 7 days, the rate-limit probe), acknowledged tenant-wide and audited
  `platform.alert.acknowledged` (Q15); counters for 1 h, 24 h or 7 d; every server instance with its `/readyz` checks,
  schema, claimed jobs, sockets, rate-limit store, tracing and NTP offset; the next schedules; the recent audit; and
  capacity (database size and pool, vectors, blob store). `GET /api/admin/overview`.
- Instances register themselves: each server process beats into `platform_instances` every 30 seconds (migration
  `037b_platform_ops`) with what `/readyz` answers, which now shares that code. Draining an instance from the screen
  (Q14: a confirm and a recent sign-in, `platform:manage`) stops it claiming jobs and makes `/readyz` answer 503 with
  `checks.shutdown: draining`; audited `platform.instance.drained`.
- The Jobs and queues screen is live, with five tabs: Queues (every job type with queued, running, oldest, failed,
  p50 and p95, and pause by type, which every instance honours within one poll: `jobs.type.paused`,
  `jobs.type.resumed`), Jobs (filters by state, type, window, job id or trace id; cancel and retry, retry every failed
  job: `jobs.cancelled`, `jobs.retried`), Schedules (last runs, run now, pause: `jobs.schedule.*`), Dead letters
  (moderation jobs and workflow runs, redriven or discarded with a reason: `jobs.deadletter.discarded`) and Cache (the
  tenant cache's namespaces with reads, hits and invalidations, and invalidate: `jobs.cache.invalidated`, Q1). System
  admins see every tenant's jobs with a tenant filter, tenant admins their own (Q9). `JobQueue` gains pause by type
  and `requeue`; `Scheduler` lists its schedules, runs one now and skips a paused one.
- Both screens are in the accessibility and reflow checks (axe-core, Standard and Enhanced, light and dark, 320 and
  640 px) through their own Playwright spec; `docs/accessibility.md` lists them.

### Storage and Configuration live (Sprint 35c, B-4204, B-4205, with B-4207)

- **Storage** (B-4204) is a live admin screen (`platform:manage`) with Stores, Usage, Quarantine, Integrity and Purges.
  Stores: the blob store (health from `/readyz`, size and objects from the last verification, capacity from `statfs`),
  the database (its own size and connections), the vector store, backups, the media work directory, training datasets
  and model files, with daily growth samples (`ops.storage.sample`). Usage: bytes by workspace (files, versions,
  trash, media, knowledge uploads, attachments) against the file quota (which counts files, versions and trash), by
  user and by kind; quotas are set from the screen. Quarantine: what waits for its scan or was refused in the last 24
  hours, the ClamAV scanner (`PING`, `VERSION`, counts today), Rescan (`503` while ClamAV does not answer) and Delete,
  audited `file.quarantine.rescanned` and `file.quarantine.deleted`.
- The integrity check `ops.blobs.verify` (every `BLOBS_VERIFY_MINUTES`, or from the screen, optionally comparing
  checksums) lists the store and walks every row: **missing** objects a row names, **orphans** older than
  `BLOBS_ORPHAN_GRACE_HOURS` that nothing references (never backups or mirror files), and **mismatches** (an object
  whose SHA-256 changed without the server writing it). It never changes the store. Orphans are deleted after a dry
  run that walks the references again, by one admin with a reason (decision Q10), within `BLOBS_DRY_RUN_MINUTES`;
  audited `platform.blobs.orphans.dry-run` and `platform.blobs.orphans.deleted` with the list of objects. An expected
  checksum change is accepted with a reason (`platform.blobs.checksum.accepted`).
- Blob store migration (decision Q16) as a copy-then-switch job `ops.blobs.migrate`, started with a recent sign-in and
  a reason: every instance also writes to the target while every object is copied and its SHA-256 checked, the target
  is verified, then reads and writes switch, with reads of anything missed falling back to the old store until it is
  retired. A failure puts every instance back on the old store. The store any process uses is now a switchable store
  (`platform/blob-switch.ts`) that follows the shared mode.
- **Configuration** (B-4205) is a live admin screen: every setting this build reads, from a descriptor generated from
  `server/src/config/index.ts` (`npm run gen:settings -w server`; section, type, constraint, default, secret, hot or
  restart, description), what each instance reads and where it came from (env, file, default or override), and
  whether instances differ. Every instance reports under `INSTANCE_NAME` every `PLATFORM_INSTANCE_REPORT_SECONDS`;
  secrets are reported as set or unset, their length, file and mode and a keyed fingerprint, never their value.
  Export as `.env` (secrets masked, audited `platform.settings.exported`) and Diff against defaults.
- Database overrides for every overridable setting under dual control (decision Q2): one platform admin proposes a
  value with a reason, another approves (never the proposer). The value is checked against the field and the
  configuration's cross-field rules. A hot setting applies on every instance at once; a restart setting at each
  instance's next start (applied before the services are built), and the screen names the instances still waiting.
  Secrets and the settings needed to reach the database are not overridable; `PLATFORM_SETTINGS_OVERRIDES=false` keeps
  every setting in the environment. Audited `platform.setting.proposed`, `.approved`, `.rejected`, `.withdrawn`.
- New routes under `/api/admin/storage/` and `/api/admin/platform/settings` (`docs/api.md`, `docs/openapi.json`,
  `docs/permissions.md`); migration `037c_platform_storage`; new settings `PLATFORM_SETTINGS_OVERRIDES`,
  `INSTANCE_NAME`, `PLATFORM_INSTANCE_REPORT_SECONDS`, `BLOBS_VERIFY_MINUTES`, `BLOBS_ORPHAN_GRACE_HOURS`,
  `BLOBS_DRY_RUN_MINUTES`. The boards (B-4201) follow what the server does: the migration and the verification are no
  longer proposals, a checksum mismatch is accepted rather than re-sealed, the purge table lists the jobs the server
  schedules, and Mark restarted became Check again (the banner clears itself as instances report).
- Accessibility and reflow (B-4207, this part): both screens in the Playwright sweeps and in
  `e2e/tests/storage-configuration.spec.ts` (axe-core and the in-page checker on every tab and design state, Standard
  and Enhanced, light and dark; reflow at 320 and 640 px for the screens and their dialogs); `docs/accessibility.md`.

### Social and messaging live (Sprint 35d, B-4206, with B-4207)

- The Social and messaging screen is live (`#/social`, after Channels, its own sidebar icon; decision Q13), over
  `GET`/`PUT` routes under `/api/admin/social/` (`docs/api.md`). Migration `037d_platform_social`
  (`social_workspace_policies`, `social_tenant_settings`, `feed_trending_exclusions`, `messaging_exports`) and the
  group state `archived`. `social:manage` now also governs these policies (decision Q4); held content stays under
  `moderation:manage`.
- Feed: per-workspace approval policy (whether posts pass `user-input` in full, with the platform baseline always
  kept; who approves held posts; media allowed and their largest size), a per-tenant trending exclusion list honoured
  at once and by the `feed.trending` job, Run trending now, and the weekly digest's profile, weekday and hour (UTC),
  size and highest label per tenant, with a test digest sent to the requester alone.
- Groups and events: per-workspace defaults (who may create groups, visibility, join mode, event capacity), groups
  across workspaces with members, pending requests, upcoming events, open reports and feeds, Transfer ownership and
  Archive (read only), and the tenant's calendar feeds with Revoke: a revoked feed answers 404 on its next fetch
  (the item's "done when").
- Messaging: retention, limits, search and the tenant's summary profile; legal-hold export of a conversation under
  dual control (decision Q5): requested with a reason and a recent sign-in, approved by a second platform admin, then
  written by the job `messaging.conversation.export` as a sealed CSV only the requester downloads. Audited
  `messaging.export.*` and `messaging.conversation.exported`.
- Realtime (`platform:manage`): this instance's rooms and sockets by kind, signals per minute and those refused by
  `ROOM_SIGNALS_PER_MINUTE`, socket authentication failures, and Close a user's rooms on every instance
  (`TOPICS.roomsClose`, audited `realtime.rooms.closed`).
- Relations: follow, block, mute and list counts, the most blocked accounts (counts only), and contact rules per
  workspace (anyone in the workspace, contacts only, admins only) enforced when a conversation is started or someone
  added, on top of each person's own rule.
- Accessibility and reflow for the screen and its dialogs (B-4207's share): `docs/accessibility.md`,
  `e2e/tests/social.spec.ts`. The prototype board now names a second platform admin as the export approver and shows
  refused signals instead of a backlog, as the server reports them.

### Tenant provisioning templates (Sprint 35d, B-4501)

- Tenants are created from a template (decision Q11): **Create from template** on the Tenants screen (system
  admins), `POST /api/admin/tenants/from-template` and `exprsn-ai tenant:create --template <id>`. The first
  templates are exprsn-platform's organisation types: **enterprise** (General, Finance, People, Engineering and Legal
  workspaces up to confidential; Reader and Contributor roles; assistant, analyst and summariser profiles; an issuing
  CA), **team** (Team and Projects workspaces; a Contributor role; an assistant profile; an issuing CA) and
  **personal** (one confidential workspace; an assistant profile). `GET /api/admin/tenant-templates` lists what each
  creates. No new permission (`tenant:manage` and the system-admin role) and no migration.
- One step: the tenant, its local user store and data key, the workspaces, the custom roles (member-baseline
  permissions only, version 1 applied), draft gateway profiles pinned to a pool in the template's zone (`inference`)
  when one may process their label, the tenant's intermediate CA under the platform root when there is one (reported
  as skipped otherwise), and the first admin: `tenant-admin`, cleared for the highest workspace ceiling, a member of
  every workspace, with a single-use enrolment link by default or a password. Audited in both chains: the parts' own
  events and `tenant.template.applied {template, workspaces, roles, profiles, zone, issuer, admin}`.
- `admin:create`'s `createAdmin` takes the audit actor, so the first admin's `user.created` names the provisioning
  admin rather than the CLI.

### Groups depth (Sprint 36a, B-4401 to B-4405)

- Channels inside a group (B-4401): groups one level down with their own members, roles, posts and events, created by
  the group's owners and moderators (`POST /api/groups/:id/channels`). The group is a channel's outer boundary: only
  its readers see its channels, only its members join them, leaving the group leaves them, and archiving or deleting
  the group takes them along. The group's owners act as owners of its channels. A channel's label is never below its
  group's; raising the group's label raises the channels below it. The feed's group scope and fan-out follow the same
  rule. Migration `038_groups2`.
- Discovery (B-4402): `GET /api/groups/discover` lists the groups the caller may join, ranked by shared members and
  activity of the last 30 days, and never one labelled above the caller's clearance.
- Places (B-4403): an optional place on groups (a sealed name and a point) and a point on events, with distance
  filters (`near`, `km`) on the group list, discovery and the calendar. PostGIS narrows on PostgreSQL when the
  extension is there (the migration creates it and a GiST index when the role may), a bounding box elsewhere; one
  great-circle distance decides, so the three databases return the same groups.
- Trending groups (B-4404): the `groups.trending` job counts joins and posts per group like trending hashtags;
  `GET /api/groups/trending` and Recount now on Social and messaging.
- Group categories (B-4405, decision Q6): a tenant-managed list on Social and messaging
  (`/api/admin/social/group-categories`), a category per group, and category filters on Groups and Discover; removing
  a category leaves its groups uncategorised, never hidden.
- Screens: Groups gains Discover (ranked), Trending, category and distance filters, a group's category and place, a
  Channels tab and channel pages, and points on events; Social and messaging gains Group categories and Trending
  groups. Boards first in `design/prototype/`, then live; `e2e/tests/groups-depth.spec.ts` checks them with axe-core,
  the in-page checker and reflow.

### Blob deduplication, held form values and reveal anomalies (Sprint 36b, B-4601, B-4701, B-4803)

- Reference-counted blobs in the file store, within one tenant only (B-4601): migration `038b_dedup_held_vault`
  (`file_blobs`, `file_versions.blob_id`). When a version passes its scan and the tenant already stores the same
  content (SHA-256 of the plaintext), the version reads the existing sealed object and the quarantined copy is
  deleted; otherwise its object becomes a blob later uploads share. The trash purge releases references and deletes
  an object with its last reader; offboarding deletes the tenant's blob rows. Every upload still stores and scans its
  full bytes, and quotas still count each version's own size. The migration registers the first ready copy of each
  content per tenant. `GET /api/admin/storage/usage` adds `dedup` (objects, shared objects, references, bytes held,
  bytes stored, bytes saved, per tenant), shown on Storage, Usage. The integrity check, orphan deletion, purges and
  blob store migration see shared objects through `file_blobs.blob_key`. `file.version.ready` names the shared blob.
- Held form values (B-4701, closing the B-2205 known gap): a public form value the `user-input` guardrail holds no
  longer refuses the submission. It waits as a held submission (values sealed, `app_form_holds`) with a hold flag of
  source kind `app-form-submission`, routed to moderation queues like any flag; the submitter gets `202 {held: true}`.
  `GET /api/apps/held`, `GET /api/apps/held/:id` and `POST /api/apps/held/:id/decide` (`flags:review` or
  `moderation:review`) list, read and accept (into a record, written by no one, `source: form`) or reject it; the
  Flags decide route does the same for these flags and shows the values. Moderation shows the held submission in the
  queue inspector with Accept and Reject. At most `APPS_HELD_MAX_PER_FORM` (200) wait per form; decided ones go
  `APPS_HELD_KEEP_DAYS` (30) after the decision (`apps.held.purge`). Audited `app.form.held`,
  `app.form.held.accepted`, `app.form.held.rejected`.
- Anomaly detection on vault reveals (B-4803): reveals of KV secrets over the API are kept (`vault_reveals`,
  `VAULT_ANOMALY_HISTORY_DAYS`) and each is compared with the secret's history before it is answered: a new address,
  an odd hour of the day (once it has `VAULT_ANOMALY_MIN_HISTORY` reveals) or a burst (`VAULT_ANOMALY_BURST` reveals by
  one caller within `VAULT_ANOMALY_BURST_SECONDS`) opens a flag for the secret's owner (`vault_reveal_flags`), with a
  notification and email. `GET /api/vault/reveal-flags`, `GET /api/vault/reveal-flags/:id` and `POST
  /api/vault/reveal-flags/:id/resolve` (`secrets:read`; the owner or `secrets:admin`) list and resolve them as expected
  or suspicious; Vault has a Reveal flags tab. Detection never refuses a reveal; `VAULT_ANOMALY_BURST=0` turns it off.
  Audited `vault.reveal.flagged`, `vault.reveal.flag.updated`, `vault.reveal.flag.resolved`; `vault.reveals.prune`
  drops old reveals hourly.

### Image classification in Knowledge (Sprint 36c, B-8801 to B-8805)

- Migration `038c_knowledge_images`: the base's vision profile and image classifiers, image documents (`parent_id`,
  `media`, the sealed description, the safety score), `knowledge_doc_labels`, image eval cases (`eval_cases.media_key`,
  `media_type`) and the `knowledge_search` built-in tool.
- Images as knowledge documents (B-8801): PNG, JPEG, WebP, GIF and HEIC uploads pass quarantine and the image safety
  check (a flagged image is rejected and deleted, audited `knowledge.image.withheld`); the base's vision profile
  writes a caption and the text in the image, which become the indexed text, so a screenshot is found by a phrase from
  it. The images inside PDF and Word documents become the document's parts, at least its label; a scanned PDF is
  indexed through its images. `server/src/knowledge/images.ts`.
- The `vision` classifier engine (B-8802): labels with thresholds like `llm`, scored by a vision profile from the
  image, JSON answers validated against the labels. A knowledge base names its published vision classifiers; the
  labels are stored on each image with their scores and the classifier version (`knowledge.classify`), and a new
  version of a published classifier re-labels the base's images in the background (`knowledge.reclassify`, audited
  `knowledge.reclassified`) without re-uploading them.
- Label search (B-8803): `labels: {any, all, minScore}` on `POST /api/knowledge/search` and on the documents list
  (`labels`, `labelsAll`, `minScore`, `media=image`); `GET /api/knowledge/bases/:id/labels` for the filter chips; image
  hits carry the caption, a text excerpt, the labels and a thumbnail URL (`GET /api/knowledge/documents/:id/thumbnail`,
  at the caller's clearance). The built-in tool `knowledge_search` is the knowledge step of agents and workflows, with
  the same filters, at the label of the call.
- Console (B-8804): the Knowledge screen shows image documents with their thumbnail, caption, labels and scores, label
  filter chips, re-classify for a base and an image, and the vision profile and image classifiers in a base's settings;
  the Classifiers screen offers the `vision` engine. Prototype boards first; axe-core and reflow checks in
  `e2e/tests/knowledge-images.spec.ts`.
- Evaluation (B-8805): image cases in the eval-set format (`image` as base64 on the samples route, or
  `PUT /api/admin/classifiers/:id/samples/image`), sealed in the blob store; a vision classifier publishes only after
  an evaluation with at least 200 image cases per label. `POST /api/classify` takes an image for a vision classifier.
- Docs: `docs/api.md`, `docs/openapi.json`, `docs/security.md` (what a caption or OCR text may leak, labels as
  metadata at the image's label, known gaps) and `docs/accessibility.md`.

### HTTP tool kind (Sprint 37a, B-8901 to B-8904)

- Migration `039_tools_injection` (with the items below): `registry_http_calls`, the meter of HTTP tool calls.
- Registry tools with `impl: http` (B-8901): a method (GET, POST, PUT, PATCH, DELETE), a URL template whose path and
  query parameters come from the tool's input schema, query and header values, a body (none, the other arguments as
  JSON, or a template), a response mapping (a JSON pointer, capped in size) and a timeout. GET tools are `read`, every
  other method `write` unless the author raises it to `destructive`. Drafts go through the registry's checks (a new
  one, HTTP request), review and publish lifecycle; a draft's request can be edited. Ported from exprsn-platform's
  agent runtime (port decision D11c). `server/src/registry/http-tool.ts`.
- The outbound address guard (B-8902): every call through `platform/egress.ts` (resolved once, every address checked,
  the connection pinned, redirects not followed); cloud metadata addresses always refused, internal hosts only as
  `SERVICE_ALLOWED_HOSTS` names them, public hosts only from the tenant's list of allowed hosts (the list workflow HTTP
  steps and webhooks read). Credentials only as `vault:path#key` references, resolved at call time as the tool's
  author; a literal credential in a header, query parameter or body field is refused when the tool is saved.
- Guardrails, limits and audit (B-8903): arguments pass the `tool-call` guardrail before the request and the result
  the `context` and `untrusted-content` checkpoints after it; the tool's rate limit applies; each call is metered and
  audited `registry.http.called` with host, method, status, size and latency, never a secret. New settings
  `HTTP_TOOL_TIMEOUT_MS` (30 s) and `HTTP_TOOL_MAX_RESPONSE_BYTES` (1 MiB).
- Console (B-8904): the Registry screen's entry form has the kind Tool (HTTP request) with a vault reference picker;
  the inspector shows the request and the last day's calls; the test harness calls a read-only HTTP tool through the
  guard; Allowed hosts keeps the tenant's list. Prototype board first; `e2e/tests/registry-http.spec.ts` with axe-core
  and the reflow checks. The e2e server names 127.0.0.1 in `SERVICE_ALLOWED_HOSTS`.

### Prompt-injection defence for untrusted content (Sprint 37a, B-6901 to B-6903)

- Trust marking (B-6901): knowledge chunks, crawled pages, tool results, MCP results and HTTP tool answers reach the
  model inside `<untrusted-content>` delimiters naming the source, with their words datamarked, in chat, `/v1`, agent
  runs and workflow model steps with skills. Per profile (`profiles.trust_marking`, `trustMarking` on the profiles
  API and the Profiles screen), on by default. Calculate, delegated agents and workflows are not wrapped.
- The `untrusted-content` checkpoint (B-6902), the twelfth, with the `injection` rule mechanism (a heuristic
  classifier, or a guard model answering injection or benign). The platform baseline gains `injection-untrusted`
  (annotate: the text goes on with a warning); migration `039` adds it to an existing baseline as a new published
  version. A blocking rule in a tenant set leaves chunks out and withholds tool results. Detections are counted per
  source (`injection_detections`), audited `guardrail.injection.detected` and shown on the Guardrails screen
  (`GET /api/admin/guardrails/injection`), with Add a blocking rule.
- The injection corpus (B-6903): `server/src/guardrails/injection-corpus.ts`, 57 attacks (direct; indirect in
  documents, pages, tool, MCP and HTTP results) and 30 benign texts. CI (`server/test/sprint37a-injection.test.ts`)
  fails below a 90% detection rate or above a 10% false-positive rate, for the heuristic classifier, the checkpoint
  with the baseline rule and a guard-model rule on the fake guard model; canary cases check that a marked prompt is
  not followed.
- Tests that compared a tool result echoed by the fake model now expect it wrapped (`mcp.test.ts`, `agents.test.ts`).

### The MCP server and MCP authorization (Sprint 37b, B-7101 to B-7103)

- Migration `039b_mcp_server`: `mcp_publications`, `mcp_server_settings`, `mcp_server_holds`, `mcp_oauth`,
  `mcp_oauth_states`; `oidc_codes.resource`, `oidc_refresh_tokens.resource`, `oidc_clients.dynamic`;
  `mcp_tokens.refresh_token`, `source`, `refreshed_at`; the `records.*` built-in tools.
- An MCP server per workspace (B-7101) at `/mcp/<tenant>/<workspace>` over streamable HTTP (protocol 2025-06-18, JSON
  answers): the workspace's published workflows, its agents, one search tool per knowledge base, its registry tools and
  the record tools over low-code apps (list, query, count, aggregate, create, update, delete), in groups a client picks
  with `?groups=`. Each call acts as the person who signed in, at most at the label the workspace publishes at, through
  the tool dispatcher, guardrails and audit (`mcp.server.call`); writes wait for the person's approval from a browser
  session (`/api/me/mcp-holds`). The record tools (`records.entities`, `records.query`, `records.count`,
  `records.aggregate`, `records.create`, `records.update`, `records.delete`) are built-ins for chat, agents and
  workflows too. A separate MCP service with a service account is no longer needed to reach Exprsn-AI from an MCP client.
- MCP authorization (B-7102): the endpoint is an OAuth 2.1 resource server of the tenant's issuer, with RFC 9728
  protected resource metadata, `WWW-Authenticate` naming it on 401, RFC 8707 audiences (the resource named at the
  authorization endpoint is kept with the code and the refresh token family and becomes `aud`; `invalid_target` for a
  resource the issuer does not serve) and DPoP, optionally required per workspace. The issuer publishes RFC 8414
  metadata at the addresses MCP clients try and, when an identity admin turns it on, RFC 7591 dynamic client
  registration (`POST /oauth/register`, off by default). Discovery documents announce `authorization_response_iss_
  parameter_supported`.
- MCP client OAuth (B-7103): for per-user MCP servers, discovery (the 401 challenge, RFC 9728, RFC 8414, RFC 7591
  registration) or endpoints and a client entered by hand; each person connects with the authorization code and PKCE
  (state bound to the browser), tokens are sealed with the tenant key, refreshed before they expire and on a 401, and
  revoked at the authorization server on disconnect.
- Console: Identity gains the MCP server tab (publish per workspace, tool groups, label, DPoP, a preview, self-
  registration and the clients that registered themselves); Settings gains MCP access (connection URLs, held calls,
  connect and disconnect); MCP servers gains OAuth for users. Prototype boards first; `e2e/tests/mcp-server.spec.ts`.
- Fixed: Identity's PKCE switch for a public client is `aria-disabled`, so axe-core's enhanced contrast check no longer
  flags its dimmed label.

### SCIM 2.0, vault sharing, MongoDB leases, quote posts and visibility (Sprint 37c, B-7201, B-7202, B-4801, B-4802, B-4901)

- Migration `039c_scim_vault_posts`: `scim_tokens`, `scim_users`, `scim_groups`, `scim_group_members`;
  `vault_policies.share_secret_id` and `expires_at`; `feed_posts.visibility` and `quote_of`.
- SCIM 2.0 provisioning (B-7201): a SCIM store (`kind: scim`) in the tenant's chain, `/scim/v2` Users and Groups
  (RFC 7643/7644: create, replace, patch, delete, the full filter grammar, paging, `attributes`, ETags), SCIM tokens
  made and revoked under Identity (`identity:manage`, shown once). Deactivating a user ends their sessions, OAuth
  refresh tokens, API keys and DAV app passwords in the same request; a delete disables and unlinks them. SCIM users
  sign in through the upstream stores the SCIM store names. `server/src/identity/scim/`, `routes/scim.ts`.
- Group membership maps to roles (B-7202): group mappings with the SCIM store name SCIM groups; every membership change
  recomputes roles, clearance and workspaces (`identity.scim.reapply` after mapping changes). A local conformance suite
  (`server/test/sprint37c-scim.test.ts`) covers what the Entra ID and Okta validators check; the external validator run
  could not be made from here (`docs/identity.md`).
- Vault sharing (B-4801): share a KV secret with a person, a directory group, a workspace or an API key, as a policy
  grant of read on its exact path, with an expiry (`VAULT_SHARE_MAX_DAYS`), revocable, audited; a deny still wins and
  the label must clear the grantee. `GET /api/vault/shared-with-me`; expired shares stop applying at once and are
  removed by `vault.shares.expire`. `server/src/vault/shares.ts`.
- MongoDB leases (B-4802): `dialect: mongodb` for database engines (createUser with read or readWrite, updateUser on
  renew, killAllSessionsByPattern and dropUser at the end), tested against `mongo:8`.
- Quote posts and visibility (B-4901): `POST /api/feed/posts/:id/quote` quotes a post with a comment in any workspace
  or group the author may post in, labelled at least as high as the quoted post; `visibility: public | workspace |
  unlisted` on posts. An unlisted post is reachable by its link and absent from every feed, tag and digest; a repost
  of it is refused, a quote of it is unlisted.
- Console: Identity shows SCIM stores with their tokens and recent changes; Vault has Share, Shared with and Shared
  with you; Messages and feed has a visibility choice, Quote, the quoted post, a post opened by its link and Your
  unlisted posts. Prototype boards first.
- Settings: `VAULT_SHARE_MAX_DAYS`, `IDENTITY_SCIM_MAX_RESULTS`, `IDENTITY_SCIM_RATE_PER_MINUTE`,
  `IDENTITY_SCIM_TOKEN_MAX_DAYS`.
- Docs: `docs/api.md`, `docs/openapi.json`, `docs/identity.md` (SCIM and its conformance), `docs/security.md` (SCIM
  tokens, shares, MongoDB lease expiry, what unlisted means), `docs/accessibility.md`, `docs/permissions.md`.

### AI inventory, analytics and audit export (Sprint 38a, B-7301 to B-7302, B-7401 to B-7403, B-7501)

- Migration `040_inventory_analytics`: `inventory_systems`, `inventory_settings`, `usage_prices`,
  `audit_siem_destinations`.
- The AI system inventory (B-7301): one list of the tenant's models, profiles, agents, workflows, tools, MCP servers
  and datasets, each with an accountable owner, a human-oversight role, data provenance, model lineage (agent →
  profile → model → base weights), known issues (open flags raised in its runs, failed evaluations) and whether the
  entry is complete, on the Models screen's Inventory tab (`models:manage`). With the tenant's "publishing an agent
  needs an owner" switch on, the registry refuses to approve an agent that has no owner. Audited `inventory.updated`
  and `inventory.settings.updated`. `server/src/governance/inventory.ts`.
- The register (B-7302): `GET /api/admin/inventory/register` as CSV or JSON, every system with its lineage and the
  tenant's impact assessment, for ISO/IEC 42001 and EU AI Act deployer records; audited `inventory.exported`.
- The Analytics screen (B-7401, `usage:read`): messages, agent and workflow runs, users, tokens, GPU time and cost
  by workspace, group (through membership), model, profile and user (and tenant for system admins) over a period, a
  per-day chart, totals, every figure a sum over the metering records so a day's totals equal that day's meter.
  `server/src/tenancy/analytics.ts`, `/api/admin/analytics/summary` and `/daily`.
- Prices and chargeback (B-7402): a price per model or per pool (per million input and output tokens and per
  GPU-hour, energy or a set rate for local models, one currency per tenant, `tenant:manage`, audited); a row whose
  records a price does not cover shows no cost rather than a partial one; the chargeback per workspace and month as
  JSON or CSV with a total line that equals the screen's total, audited `analytics.chargeback.exported`.
- OpenTelemetry GenAI attributes (B-7403): `gen_ai.provider.name`, `gen_ai.response.model`,
  `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` on the `gateway chat stream` span, for Ollama and
  Chat Completions servers.
- JSONL audit exports with a chain proof (B-7501): `POST /api/admin/audit/exports/jsonl {from, to}` writes every
  event of the window (rows above the requester's clearance redacted to their hashes) and a checkpoint signed at the
  window's last sequence; `exprsn-ai audit:verify-export <file>` and `verifyAuditExport` verify it offline. The Usage
  and audit export dialog offers it.
- Audit streaming per tenant (B-7501): HTTPS (NDJSON with a sealed bearer token) or syslog-over-TLS (RFC 5424, octet
  counting, optional private CA) destinations proposed by a tenant admin and approved by a second one, tested,
  disabled, with delivery counters, on the Usage and audit screen's Exports tab; the outbound address guard applies;
  audited `audit.siem.*`. New setting `SIEM_TENANT_MAX_DESTINATIONS` (5). `server/src/audit/siem-destinations.ts`.
- Prototype boards first (Models inventory tab, Analytics, Usage and audit); `e2e/tests/analytics.spec.ts` and
  additions to `models.spec.ts` and `usage-audit.spec.ts` with axe-core.

### Red-team suites, agent identities and handoffs (Sprint 38b, B-7001 to B-7002, B-7701, B-7801)

- Migration `040b_redteam_agents`: `redteam_suites`, `redteam_runs`, `agent_identities`; `api_keys.agent_id`;
  `agent_runs.handed_to`. Job `redteam.run`. No new settings.
- Red-team suites (B-7001): an adversarial evaluation of a profile, an agent (by name) or a workflow, from the
  built-in attack categories (the Sprint 37a injection corpus cases with a canary, handed over as documents to
  summarise; jailbreaks; data exfiltration through tools, by answer or by tool call; system-prompt extraction) and
  the tenant's own cases, with a threshold and a gate. A profile answers each attack through the gateway as an
  evaluation case is answered; an agent as a child run of its own; a workflow as a run of its published version. An
  attack is resisted when the answer carries no canary, no tool call reaches for the outside address and no eight
  consecutive words of the system prompt come back. The gate: a profile with gated suites is published only once its
  settings hash has a passing run (no evaluation override opens it); an agent version is approved or restored only
  once its schema hash has one. Routes under `/api/admin/red-team`. `server/src/redteam/`.
- Red-team results as flags (B-7002): every attack that succeeded is a flag (checkpoint `red-team`, high severity for
  extraction and exfiltration), which a reviewer confirms into an eval case like any other; tenant-added attack
  cases with their own canaries.
- Agent identities (B-7701): roles, a label ceiling and keys per agent name (`/api/admin/agent-identities`). A run on
  behalf of a user acts within both grants: the user's permissions narrowed to the identity's roles, as credential
  scopes, and the lower clearance, so a tool call the roles do not cover is refused even for an admin and a run above
  the ceiling fails before it thinks; `actor.agent` beside the user in audit events. Keys minted for an identity
  authenticate as the agent on the owner's behalf, are refused once the identity is off, narrowed with its roles and
  never listed among the owner's keys. `server/src/agents/identity.ts`.
- Agent handoffs (B-7801): `handoffs` in the agent definition, offered like delegates and described as handing the
  conversation over; the handed-to run's answer ends the run as its own answer (`handedTo` on the run,
  `agent.run.handed_off`); chain references and the ceiling rule cover handoffs (`via: handoff`).
- Console: the Red team panel on the Profiles screen's Evaluations tab; the agent card's identity and red-team status
  with their modals and the handoffs field on the Registry screen; who answered on the Runs screen. Prototype boards
  first; `e2e/tests/profiles.spec.ts` and `e2e/tests/registry.spec.ts`.
- Tests: `sprint38b-redteam`, `sprint38b-identities`, `sprint38b-handoffs`; integration `redteam-agents`. The fake
  Ollama gained `leakingReply` (a model that prints its system prompt and obeys canaries).

### Row and field policies, DLP, legal hold and compliance export (Sprint 38c, B-8101 to B-8103, B-7601 to B-7603)

- Migration `040c_policies_dlp`: `app_policies`, `users.attributes`, `dlp_rules`, `dlp_patterns`, `legal_holds`,
  `compliance_exports`. Permissions `compliance:manage` (tenant-admin, legal-review) and `compliance:export`
  (legal-review, and an API key scope). Settings `DLP_MAX_TEXT_BYTES`, `COMPLIANCE_EXPORT_MAX_ROWS`,
  `COMPLIANCE_EXPORT_MAX_DAYS`. Job `compliance.export`.
- Row and field policies (B-8101, B-8102): reusable rule sets per app or entity with subjects (everyone, a role, a
  group, a workspace's members, a user), row conditions in the record query grammar whose values name the reader
  (`$user.id`, `$user.username`, `$user.clearance`, `$user.roles`, `$user.groups`, `$user.workspaces`,
  `$user.attributes.<name>`, the last set by a tenant admin on the user) and per-field grants (read, read unmasked,
  create, update) with masks `last4`, `hash` and `hidden`. The reader's grant narrows record queries, counts,
  aggregates, reads, updates, deletes, transitions, bulk writes, exports, the `records.*` tools and workflow record
  steps, and form submissions by a signed-in person; a reader no policy names reaches nothing; designers are exempt.
  `server/src/apps/policies.ts`, `/api/apps/:app/policies`.
- Explain (B-8103): `POST /api/apps/:app/entities/:entity/policies/explain` says which policies name a reader and
  why, whether a record is in their reach and by which policy, and what a field shows; the Apps screen's Policies tab
  has the editor and the explain panel.
- DLP (B-7601): rules over the built-in PII and secret detectors and the tenant's own RE2 patterns that raise the
  label and act by it (label, redact, hold) on chat and `/v1` answers, agent run outputs and uploads (attachments and
  file versions); content raised above its owner's clearance is held. A held answer goes to the flag queue as
  `DLP: <rule>`; a held run fails with the reason; a held upload is rejected. `server/src/compliance/dlp.ts`,
  `/api/compliance/dlp`.
- Legal holds (B-7602): a hold on a user or a workspace, asked for by one holder of `compliance:manage` and approved
  by another, suspends the chat, memory and file retention purges of their content until it is released; the reason
  is sealed. `server/src/compliance/holds.ts`, `/api/compliance/holds`.
- Compliance exports (B-7603): conversations (with messages), files (metadata and versions), memories, agent runs and
  accounts of a user and/or a workspace over a date range as sealed JSON Lines, requested and downloaded with
  `compliance:export` (a person or a scoped API key); rows above the requester's clearance are left out and counted;
  every request, run and download is audited. `server/src/compliance/exports.ts`, `/api/compliance/exports`.
- Console: the Apps screen's Policies tab (designers) and the Usage and audit screen's Compliance tab (DLP rules and
  patterns with a test box, legal holds, compliance exports). `e2e/tests/apps-policies.spec.ts`,
  `e2e/tests/compliance.spec.ts`.

### Image provenance and chat artifacts (Sprint 39a, B-7901, B-8001)

- Migration `041_provenance_artifacts`: `image_jobs.c2pa`, `pki_content_signers`, `chat_artifacts`,
  `chat_artifact_versions`.
- Content credentials (B-7901): a generated PNG carries a C2PA manifest store in a `caBX` chunk (`c2pa.actions`,
  `c2pa.hash.data` over every byte outside the chunk, `io.exprsn.generation`), signed as a COSE_Sign1 (ES256) by the
  tenant's content-credentials certificate, which the tenant's issuing CA makes on first use with its key in custody
  and lists among the tenant's certificates (revoke it there and the next image signs with a new one). The manifest
  travels with the bytes through the blob store, downloads and attachments; `GET /api/images/:id/content-credentials`
  and `exprsn-ai c2pa:verify <file.png> [anchor.pem…]` read it back and check the claim hashes, the data hash, the
  signature, the chain and its trust. The HMAC manifest of Sprint 20 stays and still verifies. Without an issuing CA
  or key custody the image keeps the HMAC manifest and says why. Setting `IMAGE_C2PA`. Built from the
  specification's parts (CBOR, JUMBF, COSE) in `server/src/images/c2pa.ts`; the deviations a conformance validator
  may flag are in `docs/security.md`.
- Versioned artifacts (B-8001): the fenced blocks of a finished answer become artifacts of the conversation, named
  from the fence or `<language>-<n>`; a later turn that changes one adds a version and the earlier ones stay
  readable, the same content adds none. `GET /api/conversations/:id/artifacts` and `.../versions/:n` for owners and
  share readers; transcripts of shares and links carry the artifacts of the shown messages. HTML renders in a
  sandboxed iframe on `GET /api/public/artifacts/:vid/raw`, a short-lived capability URL with its own CSP (an opaque
  origin with no access to the console, its cookies or the API). Settings `CHAT_ARTIFACT_MIN_CHARS`,
  `CHAT_ARTIFACT_MAX_BYTES`, `CHAT_ARTIFACT_RAW_TTL_SECONDS`.
- Console: the Images inspector and download dialog show the content credentials beside the HMAC manifest, with a
  details dialog of every check; the Chat inspector (and the shared and public link views) has an Artifacts panel with
  chips under each answer, a version switcher, the sandboxed render and text views. Prototype boards first;
  `e2e/tests/chat.spec.ts` and `images.spec.ts` extended with axe-core.

### App packages, environments and promotion (Sprint 39b, B-8201 to B-8204)

- Migration `041b_app_packages`: `app_packages`, `app_pipelines`, `app_deployments`. Settings `APPS_PACKAGE_MAX_BYTES`,
  `APPS_DEPLOYMENT_HISTORY_DAYS`, `APPS_GIT_TIMEOUT_MS`, `APPS_GIT_ALLOW_FILE`. Job `apps.deploy`.
- App packages (B-8201): `exprsn-app/2`, the whole of an app's design (entities with their fields, formulas and state
  machines, forms, record and schedule triggers naming their workflows, the row and field policies, and the published
  workflows the triggers name as signed workflow bundles), with the records when asked for, signed with the KMS key
  over its canonical JSON, numbered per app and kept sealed. Import verifies the signature over exactly what arrived
  before anything is read (`422 Package refused`, audited `app.import.refused`); the old bundle door takes a package
  too. A package imports as a new app or applies to an app in place with entities, forms, triggers and policies
  reconciled by name (an entity still holding records is kept and reported). `server/src/apps/packages.ts`.
- Environments and promotion (B-8202): a pipeline names three apps as development, test and production and the
  workflow whose approval step guards production. A promotion to test packages the development app now; a promotion
  to production lands the exact package the last successful promotion to test landed (a stage cannot be skipped),
  once a run of the approval workflow, started with the deployment as its input and caller, succeeds; a rejected,
  failed or expired run rejects the deployment and tells the requester. `WorkflowService.start` takes a `caller`.
  Audited `app.package.promotion.requested`, `app.package.promotion.approved`, `app.package.promotion.rejected`,
  `app.package.promoted`. `server/src/apps/pipelines.ts`.
- Backups, history and rollback (B-8203): every deployment first packages the target (`source: backup`); the history
  keeps source, target, version, who, state and the report for `APPS_DEPLOYMENT_HISTORY_DAYS`; a rollback deploys the
  backup onto the same stage as a deployment of its own, audited `app.package.rolled_back`; a failure is audited
  `app.package.deployment.failed` and notified.
- Git export and import (B-8204): a package pushed to a repository as one readable JSON file per object
  (`package.json` with the signature, `app.json`, `entities/`, `forms/`, `triggers/`, `policies/`, `workflows/`,
  `records/`) and read back from one, reassembled in signing order and verified like a pasted package; https only
  (`file://` when `APPS_GIT_ALLOW_FILE`), a vault-held token answered to git through a credential helper. Audited
  `app.package.pushed`.
- Console (B-8201 to B-8204): the Apps screen's Deployments tab for designers: packages (make, download, push to git,
  import, import from git), the pipeline's stages with promote, edit and delete, and the deployment history with
  rollback; the page refreshes while a deployment is going. Prototype board first; `e2e/tests/apps-deployments.spec.ts`
  with axe-core.

### Data model generation, AI fields and outside database sync (Sprint 39c, B-8301, B-8401, B-8402, B-8501)

- Migration `041c_model_gen_sync`: `app_ai_fills`, `app_entity_sources`, `app_records.ai_pending` and
  `app_records.external_key`. Settings `APPS_AI_DEBOUNCE_MS`, `APPS_AI_FILL_MAX_ROWS`, `APPS_SOURCE_PULL_MAX_ROWS`.
  Jobs `apps.ai-fill-all`, `apps.source-pull`, `apps.source-schedules`.
- Data model drafts (B-8301): a description of an app becomes a draft of its whole data model from a local model
  through a published profile (entities, typed fields, relations, formulas, state machines, record triggers naming
  existing workflows), validated like a saved entity and shown as a diff per entity (new, changed, fields added,
  changed, omitted but kept, states); accepting it creates the new entities in dependency order, extends existing ones
  without removing anything and creates the triggers whose workflow exists, in one request. `POST
  /api/apps/{app}/model/draft` and `/model/apply`; audited `app.model.drafted` / `app.model.applied`.
- AI field prompts (B-8401) take field names and formulas over fields as placeholders (`{{upper(name)}}`), checked when
  the entity is saved; an edit regenerates only the AI fields that read a changed field, once per quiet window.
- AI fills over every row (B-8402): fill the empty values or refresh every record of one AI field as a job with an
  estimate first (records, tokens, the cost at the tenant's model price), progress and token totals on the fill, and a
  cancel between records; `/api/apps/{app}/entities/{entity}/ai/estimate|fills`; audited `app.ai.fill.started` /
  `cancelled` / `finished`.
- Outside tables as entities (B-8501): an entity backed by a table of a PostgreSQL or MySQL data connection: a pull (on
  demand or every N minutes) brings its rows in as records keyed by the key column, typed by the fields, with the
  state from a mapped column and rows gone removed; with writes on, a record created, changed, moved or deleted in
  the app reaches the table first (insert, update, delete through the drivers' new row mutation) so a refused outside
  write changes nothing here; attaching needs `apps:design` and `connections:manage` and an entity label covering the
  connection's. `/api/apps/{app}/entities/{entity}/source` and `/source/pull`; audited
  `app.entity.source.set` / `updated` / `removed` / `pulled` / `pull_failed`.
- Console (Apps screen): the draft dialog with its diff and editable JSON, an "AI fills over every row" panel and an
  "Outside table" panel on the Entities tab; prototype boards first; `e2e/tests/apps-model.spec.ts` with axe-core.
- Unit tests on SQLite (the outside table as a SQLite stand-in behind the real connection flow) and an integration
  test through the real PostgreSQL and MySQL drivers.

### Entity APIs and app embedding (Sprint 39d, B-8601 to B-8603, B-8701, B-8702)

- Migration `041d_entity_api_embeds`: `api_keys.app_scope`, `app_schema_versions`, `app_embeds`, `app_embed_keys`,
  `app_embed_pages`, `app_embed_sessions`. New settings `APP_EMBED_MAX_TTL_SECONDS` (3600) and
  `APP_EMBED_SESSION_PER_MINUTE` (30).
- The entity API (B-8601): every entity of an app is a REST resource at `/api/apps/:app/:entity`: list with a JSON
  `filter`, `where=field:op:value` conditions, `sort`, `q`, `limit`, `offset` or `cursor`, and `include=related` for the
  records the reference and lookup fields point at; read, create, update with `version`, transition and delete. The
  same service as the records routes, so policies, masks, labels, workspaces and audit apply unchanged. API keys may
  be limited to one app or one entity (`POST /api/me/api-keys {app: {app, entity?}}`, `records:read` and
  `records:write` only): accepted under `/api/apps` alone and refused on another app or entity.
- Schema versions and the schema API (B-8602): every design change, whichever route makes it, records a version
  with a hash of the whole design (`app_schema_versions`, audited `app.schema.versioned`); `/api/apps/:app/schema`
  reads the design and its versions, and creates, replaces or deletes entities, fields, state machines and forms.
- OpenAPI and a client per app (B-8603): `GET /api/apps/:app/openapi.json`, an OpenAPI 3.1 document typed from the
  entity definitions with the schema version and hash (its `ETag`), and `client.ts` or `client.js`, a generated
  client that creates a record against a fresh app with no hand-written code.
- Public embeds (B-8701): a public form published as an embed page under a random id (`/embed/:id`), served with
  `frame-ancestors` naming the app's allowed host sites and no `X-Frame-Options`; opened and submitted by that id
  through `/api/public/embeds`, on the public submission path, with the form's link token never on the page.
- Signed embeds (B-8702): keys registered per app (ES256, RS256, EdDSA public keys, an HS256 secret shown once, or
  the tenant CA verifying the token's `x5c`); a host token with the app as audience, `exp`, `jti` (once per key) and
  the claim that names the person is exchanged at `/api/public/embeds/session` for an embedded session, a bearer of
  its own apart from console sessions, inside the app's entities, read-only unless the app allows writes, capped by
  the app's limit and the server's; revoking a key ends its sessions; every exchange is audited.
- Console: the Apps screen's API tab (routes per entity, a curl, the schema version and hash, the downloads, the
  versions table) and Embed tab (settings, keys, pages with their iframe snippet, sessions); the embed pages
  (`web/js/embed.js`); Settings lets a key be limited to an app and an entity.
- Prototype boards for the two tabs and the key option; `e2e/tests/apps-api.spec.ts` with axe-core on the tabs and
  the embed page; unit tests `sprint39d-entity-api`, `sprint39d-schema-api` (the generated client runs against the
  test server), `sprint39d-embeds` (every key kind, a tenant CA built in the test); an integration test for
  PostgreSQL and MySQL.
- Known gaps in `docs/security.md`: an entity named like one of the app's own route segments is reached only through
  the records routes; a schema version holds the whole definition, not a diff, and nothing restores one; an
  app-limited key is refused on `/v1` and the MCP server outright; the tenant CA path checks one intermediate and
  no OCSP; the session's `host` is the token's `iss`; a reload of an embed page needs a new host token.

### Pinned models stay pinned while they serve

- Every chat and embedding request to an Ollama instance now carries its placement's keep-alive: `-1` for a pinned
  model, the instance's keep-alive for a warm one, none for a cold one (Ollama's default). Before, only explicit
  loads set it, and Ollama resets a model's expiry on every request, so the first answer a pinned model gave set its
  expiry back to Ollama's default (five minutes) and the pin was lost. The keep-alive per model is refreshed on every
  instance poll.

### Release 1.6.0 (B-5101)

- Sprints 35 to 39 as above, released on 2026-10-09 (PR #71). Dropped: B-5001, capability tokens (owner, 2026-10-07).
  Partial: B-7202, SCIM against the Entra ID and Okta validators (a local conformance suite stands in). B-11707
  (Sprint 36b, model thinking templates) was pulled forward from 1.7.0 on 2026-10-08 and lands after the release.
- Checks on the release tree: lint, typecheck and the console parse check; 1170 unit and API tests across 126 files,
  1 skipped; the PostgreSQL integration suite (52 files); the prototype smoke (51 screens); the full Playwright
  console suite run locally, 168 passed, 0 failed, after fixes to the sweep's screen list, the e2e harness driver,
  an Analytics reload race and the data model draft dialog's accessibility pass.
- Migrations `037_model_servers` to `041d_entity_api_embeds`, all expand-only. New CLI commands
  `audit:verify-export` and `c2pa:verify`.

## 1.5.0

### Model thinking templates (Sprint 36b, B-11707)

- Migration `041e_thinking_templates`: `models.thinking` (native, template, none; null derived from the capabilities)
  and `models.thinking_template`.
- A catalogue entry records how its model is made to think, and profiles inherit it (B-11707): a pull reads the mode
  from the server's `show` (a default system prompt that asks for `<think>` blocks makes a template model and is
  kept as its convention; the thinking capability alone makes a native one); `PATCH /api/admin/models/:id` overrides
  `thinking` and `thinkingTemplate`, audited. `server/src/gateway/thinking.ts` turns a profile's level into the
  request for its model in chat, compare, agent runs, evaluations, workflow model steps and `/v1`: the think
  parameter for a native model; for a template model the convention appended to the system prompt (added when the
  profile has none, left alone when it already carries `<think>`), the think flag when the server claims the
  capability, and the `<think>…</think>` block split out of the answer as thinking across chunk boundaries; with the
  level off, a direct-answer prompt in place of a missing one, so the server substitutes none of its own. A profile
  on Magistral thinks without a hand-written convention. The publish check refuses a thinking ceiling only on a
  `none` model.
- The catalogue evaluation sends a system prompt with both tests, as chat sends a profile's: without one Ollama
  substituted the model's own, under which Magistral answered the tool-calling test in prose and had its tools
  withheld.
- Console: the model card's "Thinking" row and the edit dialog's mode and convention; the Profiles checks name the
  inherited mode. The Models board carries the row. `server/test/fake-ollama.ts` has `templateModel`, a
  Magistral-like model; e2e: `models.spec.ts`, `profiles.spec.ts`.

### Chaining agents, skills, tools and workflows (Sprint 34a, B-4102 to B-4107)

- Built on the chain context of Sprint 32 (B-4101): every link is a node of the caller's chain, acts as the chain's
  principal, runs at the chain's label within the callee's ceiling and is charged to the root's budgets. Migration
  `036_chains` (`chain_nodes.decision` and `error_type`, two indexes). No new permission.
- Agents delegate to agents (B-4102): an agent's `definition.agents` (up to 16) lists the agents it may call, each
  offered to the model as the tool `agent:<name>`. A call passes the dispatcher like any tool call and starts a child
  run of the published delegate as the same principal, at the chain's label, with budgets no larger than the
  delegating run has left; the delegating run waits and continues with `{run, agent, answer}`, the answer typed by the
  delegate's `outputSchema` when it declares one (agents take `inputSchema` and `outputSchema`). Audited
  `agent.run.delegated`; cancelling a run cancels the runs it delegated to.
- Skills compose (B-4103): a skill's `definition.skills` lists the skills it builds on; loading a skill loads its
  closure once each, dependencies first (at most 32), and offers the tools of the whole closure, deduplicated. Every
  skill of the closure is a `skill-load` node of the chain.
- Workflows an agent lists (B-4104): `definition.workflows` (up to 16) are offered as `workflow:<name>` and run and
  awaited as a workflow tool is (B-1006), without publishing one; a workflow the agent does not list is refused.
  `GET /api/workflows/:id/callers` adds the agents that list the workflow.
- Chain checks at publish (B-4105): the registry and workflow publish build the reference graph across agents, skills,
  tools and workflows. A cycle made only of steps that always run is refused (the registry's **Chain references**
  check; a workflow publish answers `422` with code `chain` and the path); a cycle through a model's choice is a
  warning; references above the referrer's ceiling and unpublished references fail the check. "Used by" at
  `GET /api/admin/registry/:id/used-by` and `GET /api/workflows/:id/used-by`; retiring the last callable version of an
  entry something live uses, or deleting a workflow a published agent or workflow uses, is `409 Still in use`, naming
  them.
- Approvals and failures through the chain (B-4106): a call held anywhere pauses the chain. The root's run views list
  the held calls (`held`, with the path), and `POST /api/chains/:id/held/:node/decision` decides one with the rules of
  the place where it waits (audited `chain.held.decided`). A model step's skill call that needs approval now pauses the
  step on an approval (`approverRole`, `approvalTimeoutMs`) instead of being reported to the model. A child's failure
  reaches its parent typed (`failed`, `budget`, `cancelled`, `rejected`, `chain_limit`, `output`, `label`, `timeout`):
  an agent sees a tool error starting `child_<type>:`, a workflow's failure edge receives `type`.
- The chain view (B-4107): `GET /api/chains/:id`, the tree of invocations with timing, tokens, steps, wall and GPU
  time, labels, guardrail decisions, audit links and held calls; its totals equal what was metered for the chain.
  `POST /api/chains/:id/nodes/:node/replay` replays an agent-run or workflow-run node from a step as a new chain
  (audited `chain.node.replayed`); `GET /api/admin/audit` takes a `target` filter.

### The chain tree and registry fields in the console (Sprint 34d, B-4108, B-4109)

- Prototype boards (B-4108): Runs gains the chain tree with a node inspector (usage and subtree, label, guardrail
  decisions, typed error, audit link, replay from a node) and held calls decided from the root with their path;
  the registry editor gains agent delegates, listed workflows, input and output schemas, skill dependencies with the
  loaded closure, the Chain references check and a "used by" view before deprecating or retiring; Workflows gains
  "used by" before deleting and a Chain tree button on runs. The smoke run is clean in light and dark.
- Live screens (B-4109): the tree comes from `GET /api/chains/:id` and opens from a run, a workflow run or
  `#/runs?chain=<id>&node=`; held calls are decided through `POST /api/chains/:id/held/:node/decision` and nodes
  replayed through the chain replay route; Retire and Delete are disabled while an entry is still used.
  `e2e/tests/runs-chain.spec.ts` opens a three-level chain (planner, broker, clerk) as a tree from its root run with
  no axe-core, in-page checker or reflow finding, and approves a `feed.post` call held three levels down from the root.
  The fake model in `e2e/server.ts` makes the tool call named on an `E2E-CALL` line of an agent's prompt; the reflow
  check is shared from `e2e/tests/support/reflow.ts`.
- Fixed on Runs: a run with its own error text no longer shows "The run could not be loaded", and route parameters
  no longer cause a re-fetch loop.
- Known limit: the registry editor cannot clear an agent's input schema once set (the PATCH schema does not take
  `null`).

### Profiles and presence (Sprint 34c, B-5801, B-5802)

- Migration `036b_profiles` (`user_profiles`, `user_presence`, `presence_connections`). Routes `/api/people` and
  `/api/presence` under `social:read` and `social:write` (an avatar also needs `files:write`), answered with
  `Cache-Control: no-store`.
- Profiles (B-5801): pronouns (up to 40 characters) and a bio (up to 500) screened at the `user-input` guardrail; an
  avatar (PNG, JPEG, WebP or GIF, at most 2 MiB) uploaded into the file store of the caller's current workspace
  through its quarantine and served only while its pinned version is a ready image, not in the trash, within the
  viewer's clearance; a version that fails its scan is never shown. A profile is known to people who share a workspace
  with its owner (anyone else gets `404`); the pronouns, bio and avatar further need the viewer's clearance to reach
  the profile's label and, when the owner narrowed it, a shared workspace among those named. Two people in a block see
  each other's name only. Audited `profile.updated` (the fields, never the text), `profile.avatar.set`,
  `profile.avatar.removed`.
- Presence (B-5802): available, away, busy or offline, chosen or `auto` (away while every socket the person holds
  reports idle); without a connected socket a person reads offline. `PUT /api/presence/me` is audited
  `presence.status.updated`. On the console's socket, `presence.watch`, `presence.unwatch`, `presence.idle` and
  `presence.changed`: each change is published once and relayed by every instance without the sockets of people in a
  block with the person, and a new block takes each out of the other's presence room at once. Connections are kept per
  instance with a 30-second heartbeat and swept after 90 seconds.
- Console: a Profile page opened from people's names on Messages, the feed and Groups, with a People directory; the
  public profile (pronouns, bio, picture) and status in Settings; the console reports idle after five minutes without
  input or while the page is hidden. Fixed: the feed's Post handler matched any click inside a post.

### The IMAP channel adapter against a real IMAP server (Sprint 34b, B-3605)

- `server/test/integration/imap.test.ts` (gated on `TEST_IMAP_URL` and `TEST_IMAP_SMTP_URL`): mail delivered by SMTP
  to a GreenMail mailbox becomes a channel thread through the `channels.imap-poll` job and imapflow, is answered
  through the outbox, a reply in the thread joins the session, nothing is marked seen, and a wrong password is
  recorded on the cursor and audited once. `server/test/integration/greenmail.sh` starts GreenMail 2.1.5 (pinned by
  digest) with a throwaway CA; the CI integration job runs it.
- CI: the MongoDB service's health command no longer has a `: ` in a plain YAML scalar.

### WebDAV for the file store (Sprint 34b, B-3201 to B-3203)

- Migration `036c_dav_files` (WebDAV locks). Described in `docs/dav.md`.
- B-24 workspaces, folders and files as WebDAV collections under `/dav/files/` (and `~shared` for files shared with
  the caller): PUT through quarantine, the type check and ClamAV, scanned before it answers and unreadable until it
  passes; every PUT a new version; DELETE to the trash; Finder's AppleDouble files dropped (B-3201).
- COPY and MOVE for files and folders (MOVE keeps ids, so versions and shares stay; COPY scans again), LOCK and UNLOCK
  (class 2, exclusive and shared, depth 0 and infinity, lock-null resources, the If header with lock tokens) (B-3202).
- Quota properties (RFC 4331) and 507 over a limit; the `litmus` suite (basic, copymove, props, locks, http) in CI,
  all passing (B-3203). `JobQueue.runNow` and `FileService.scanNow` run a version's scan job before answering.

### Workflows 2 and the chain context (Sprint 32, B-3901 to B-3910, B-4101)

- Migrations `034_workflows2` (`chains`, `chain_nodes`, `workflow_items`; the chain on agent and workflow runs),
  `034b_workflow_triggers` (`workflow_triggers`, `workflow_trigger_firings`, `workflow_dead_letters`) and
  `034c_workflow_steps` (the domain built-in tools, a feed post's source, approval forms and answers). New settings
  `CHAIN_MAX_DEPTH`, `CHAIN_MAX_TOKENS`, `CHAIN_MAX_STEPS`, `CHAIN_MAX_WALL_SECONDS`, `CHAIN_MAX_GPU_SECONDS`,
  `WORKFLOW_MAX_DEPTH`, `AGENT_MAX_DEPTH`, `WORKFLOW_EVENT_RATE_PER_MINUTE`, `WORKFLOW_EVENT_MAX_DEPTH`,
  `WORKFLOW_SCHEDULE_TICK_SECONDS`. No new permission.
- The chain context (B-4101): every invocation (a chat turn whose answer calls a tool, an agent run, a workflow run, a
  tool call, a skill load, a plugin action that starts a workflow, an app trigger) is a node of its root's chain. A
  child acts as the root's principal, its label is at least the chain's high-water mark, and depth is capped by one
  `CHAIN_MAX_DEPTH` (default 8) across kinds, with `WORKFLOW_MAX_DEPTH` and `AGENT_MAX_DEPTH` (3 each) as per-kind caps;
  tokens, steps, wall time and GPU time are charged atomically to the root's budgets. Nodes are unique by kind and
  reference, so a job retried on another instance resumes its node. Refusals are audited `chain.refused`, a budget stop
  `chain.stopped`; a refused tool call reaches the model as a `chain_limit` tool error. Run views carry `chain` and
  `caller`, and workflow runs their `children` and map and loop `items`.
- Sub-workflow, agent, `map` and `loop` steps and skills on model steps (B-3901, B-3902, B-3905): a `sub` step runs a
  published workflow as a child under the parent's owner and label, and the child's approvals pause the parent; an
  `agent` step runs a published agent and waits without a worker; `skills` (up to 8) on a `model` step load published
  skills' instructions and tools through the dispatcher, so every call passes the tool's ceiling, schema, the
  `tool-call` checkpoint and its rate limit; `map` fans out over up to 200 items (`maxParallel` up to 20) with each
  item's result checkpointed, and `loop` iterates up to 40 times with an optional `while`. `GET /api/workflow-callees`
  lists what the new steps may call.
- Triggers on the workflow itself (B-3903): source `event` (a catalogue event or group, with the plugin fan-out rules:
  workspace, label, `WORKFLOW_EVENT_RATE_PER_MINUTE`, no loops through the chain of workflows) and source `schedule`
  (a five-field UTC cron, each due time claimed once across instances). Runs start as the version's publisher with
  what they hold at that moment, or are skipped with the reason. `GET` and `PATCH /api/workflows/:id/triggers`;
  audited `workflow.trigger.*`.
- Failure handling (B-3906): a per-step `retry` (up to 5, fixed or exponential, waiting durably), an on-failure edge
  (`branch: failure`) whose steps receive `{error, step}`, and dead letters for runs that fail for good, with redrive
  from the failed step (`/api/workflow-dead-letters`, audited `workflow.run.dead_lettered` and
  `workflow.dead_letter.redriven`).
- Bundles (B-3909): signed `exprsn-workflow/1` export (`GET /api/workflows/:id/bundle`) and import
  (`POST /api/workflows/import`) with tool, profile, app, vault and trigger references re-bound; a bundle changed after
  signing is refused with `422 Bundle refused`.
- Domain built-in tools (B-3904): `messages.send`, `feed.post`, `files.write_version`, `groups.create_event` and
  `channels.answer` (`impl: builtin`, published to every tenant, all `write`), acting as the caller through the domain
  services and called the same way from chat, agents and workflows; a post made by a built-in or a plugin records its
  `source`. The plugin broker's `records.read`, `records.write`, `files.read`, `groups.read` and `posts.write` calls are
  live, acting as the installing user within the plugin's max label.
- Approval forms (B-3907): an `approval` step names an app form; the approver's answers are validated like a
  submission, sealed with the approval, become the step's output and are audited with the decision. `notify` and
  `webhook` steps (B-3908): in-app and email notices to cleared recipients (`workflow.step.notified`); one signed
  delivery per run and step through the tenant's webhook path, with the endpoint checked against the outbound host rules
  when the graph is saved (`422 Workflow invalid` otherwise).
- Console (B-3910): the live Workflows screen edits every step kind the server has, sets event and schedule triggers,
  per-step retries and failure edges, and has the run history (with chain, caller, children and items), Triggers and
  callers (`GET /api/workflows/:id/callers`), versions with bundle export and import, approvals and dead letters with
  redrive; a New workflow button in the toolbar. The event catalogue is also readable with `workflows:manage`.

### App passwords for DAV clients in Settings (Sprint 32, B-3415)

- `GET /api/me/dav`: the CalDAV, CardDAV and WebDAV discovery URLs, the username to type into a client, which scopes
  the caller's roles make usable, and how long the session's second-factor confirmation still counts for creating an
  app password. The create response also names the WebDAV URL (`/dav/files/`, B-32).
- Settings has a panel under Security with each device's app password (scopes, creation, last use with time, address
  and client, expiry) and Revoke; creating one asks for an authenticator code or a passkey first when the second factor
  is older than the step-up window (the password does not count), and the password is shown once. The step-up dialog
  takes a factor-only mode, used whenever the server answers `step_up` with `factor`.

### Console screens for the 1.4.0 domains (Sprints 29 to 31, B-3401 to B-3414)

- Prototype boards in `design/prototype/` for every new screen and the identity additions (B-3401), with the Workflows
  board realigned on the server's step kinds.
- Live screens: Certificates (B-3402), Vault (B-3403), Plugins and events (B-3404), Apps (B-3407), Files (B-3408) and
  the identity additions on Identity, User stores, Settings and Sign in (B-3413); Moderation (B-3405), Groups and events
  (B-3409), Channels (B-3410), Messages and feed (B-3411) and Roles and access (B-3412); and AT-Protocol (B-3406,
  Sprint 31), with the read endpoints and fields they need on the server. Each joined the Playwright suite with
  axe-core (Standard and Enhanced, light and dark) and the reflow checks for its dialogs and drawers, described in
  `docs/accessibility.md` (B-3414).

### Custom feed generators, relay commit verification and the RSVP race (Sprint 31b, B-3001 to B-3003, B-3604, B-3603)

- Feed generators (B-3001): a tenant's feeds are served by its own AT-Protocol identity, whose DID document gains a
  `#bsky_fg` `BskyFeedGenerator` service (did:web computed; did:plc through a signed PLC operation, audited
  `atproto.identity.service-added`). Public XRPC `app.bsky.feed.describeFeedGenerator` and
  `app.bsky.feed.getFeedSkeleton` at `/xrpc/…` and `/atproto/<key>/xrpc/…`; an inter-service JWT (ES256K or ES256)
  is verified against the issuer's `#atproto` key, its audience, expiry and `lxm`, and a bad one is refused with `401`.
- Feeds as rules over the firehose (B-3002) under `/api/atproto/feeds` (`firehose:manage`, audited
  `atproto.feed.*`): authors, collections, keywords and labels (in force from the tenant's labeler and trusted
  labelers, or the check's verdict; `!hide` excluded by default), checked again when served; optional ranking by
  embedding similarity through a gateway profile or by a classifier's score. Posts reach the feeds after the
  moderation check; deletes leave them.
- The feed index (B-3003): keyset cursor pagination by (sort, id), retention and a size cap pruned by
  `atproto.feeds.prune` every `FEED_PRUNE_MINUTES`, and a per-feed rate limit on getFeedSkeleton. Migration
  `033b_feeds` (`atproto_feeds`, `atproto_feed_items`, `firehose_subscriptions.rejected`). New settings
  `FEEDS_MAX_PER_TENANT`, `FEED_ITEMS_MAX`, `FEED_PRUNE_MINUTES`, `FIREHOSE_REJECT_AUDITS`.
- B-3004 (publishing the `app.bsky.feed.generator` record) has its interface: the feed view's `record` (naming the
  generator's service DID) and `PUT`/`DELETE /api/atproto/feeds/{id}/publication`.
- Relay commit verification (B-3604): subscribeRepos commits are checked against the repo's `#atproto` key (DID
  documents through the service URL checks, cached, refreshed once on a failed signature) and each record used is
  proven against the signed Merkle search tree; a commit that fails is dropped, counted (`counts.rejected`) and
  audited `atproto.firehose.commit.rejected` (rate-limited). Tested against the AT-Protocol interop vectors (MST key
  layers, commit proofs, signature fixtures) in `server/test/fixtures/atproto/`.
- RSVP capacity (B-3603): the event row is locked (`SELECT … FOR UPDATE` on PostgreSQL and MySQL) while the places are
  counted; fifty simultaneous RSVPs for one place leave one attendee on SQLite, PostgreSQL and MySQL.

### The AT-Protocol personal data server (Sprint 31, B-2901 to B-2906, B-3004)

- Exprsn-AI hosts AT-Protocol repositories, described in `docs/pds.md`. Hosting is off until a platform admin enables
  it per tenant (`PUT /api/admin/pds/tenants/{tid}`), and is refused in an air-gapped deployment or a PDS zone without
  egress: repositories are public by protocol. New permission `pds:manage` (tenant admins); members keep their own
  account under `atproto:link`. Migration `033_pds`; new settings `PDS_*`; the event catalogue (version 7) lists a
  `pds.*` group.
- Accounts are tied to Exprsn-AI users: a did:plc whose repo and rotation keys live in the signer or OpenBao, a handle
  `<name>.<tenant>.<PDS_HANDLE_DOMAIN>` that resolves to it (`/.well-known/atproto-did`, `resolveHandle`), created from
  the console or by `com.atproto.server.createAccount`, which follows the tenant's sign-up policy with invite codes
  for closed and approval policies (B-1801). Bluesky clients sign in with app passwords made in the console; the
  Exprsn-AI password never works over XRPC. Sessions are refresh-once token pairs (B-2901).
- Repositories: the Merkle search tree, signed version 3 commits, DAG-CBOR and CAR, matched byte for byte against the
  AT-Protocol interop fixtures and the reference implementation; `com.atproto.repo` writes (`createRecord`,
  `putRecord`, `deleteRecord`, `applyWrites`) validated against the bundled Bluesky lexicons; reads and the
  `com.atproto.sync` exports (`getRepo`, `getRecord`, `getBlocks`, `listBlobs`, `getBlob`, `getLatestCommit`,
  `getRepoStatus`, `listRepos`) (B-2902).
- Blobs stream through the attachment quarantine, typed from their bytes, limited per tenant, scanned by ClamAV and
  sealed at rest; a blob that fails the scan is never served (B-2903).
- The firehose: a sequencer whose seq is taken in each commit's transaction, `com.atproto.sync.subscribeRepos` with
  cursors, a backfill window and sync 1.1 commit proofs, and `requestCrawl` to the relays in `PDS_RELAYS` (B-2904).
- Deactivation, takedowns as moderation actions on `pds-repo` objects (`RepoTakendown`, `!takedown` published by the
  tenant's labeler, appealable), and account migration into and out of Exprsn-AI with signed PLC operations (B-2905).
- Interop: `interop/run.ts` and the CI `interop` job run the PDS against the reference development environment's PLC
  directory and Bluesky AppView; a post written to Exprsn-AI's PDS appears in the AppView (B-2906).
- `app.bsky.feed.generator` records published to a hosted repo or an external account
  (`POST /api/admin/pds/feed-generators`), naming the feed generator's service DID (B-3004).
- Moderation gains `takeDown` and `reverse` for direct admin actions; self-registration takes an AT-Protocol invite
  code in place of an invitation.

### Model-based memory management (Sprint 30, B-3701 to B-3703)

- Per-tenant memory settings under `GET`/`PUT /api/memory/settings` (`knowledge:manage`, audited as
  `memory.settings.updated`). Migration `032c_memory` (`memory_settings`; `memories.superseded_by` and
  `memories.expiry_proposal`).
- A tenant `memory` profile extracts proposals from chat turns and, under an agent's memory policy, from succeeded
  agent runs (`memory.extract`). The text goes to the model as JSON data and its answer must be one JSON object that
  a zod schema accepts; with no profile, or when the model fails or answers anything else, the rules extract as before
  (`memory.extraction.fallback` records why). Every proposal still passes the `memory` checkpoint, the credential ban
  and the rejection list, and carries its source's label (B-3701).
- Consolidation (`memory.consolidate`, daily and `POST /api/memory/consolidate`): near-duplicates found by embedding
  similarity and confirmed by the profile become one merge proposal (keeping both sources); stale and contradicted
  memories get expiry proposals, decided with `POST /api/memory/{id}/expiry/accept|reject`. Nothing changes until a
  person accepts; accepting a merge activates the new memory and retires both (`superseded`, `supersededBy`, audited
  as `memory.merged`) (B-3702).
- The memory embedding model is a tenant setting (unset: the first approved embedding model by name, as before).
  Changing it starts `memory.reindex` (also `POST /api/memory/reindex`), which re-embeds every active memory; recall is
  by recency while it runs, and only vectors of the query's model are compared (B-3703).
- The event catalogue lists a `memory.*` group for the memory audit actions.

### CalDAV and CardDAV (Sprint 30, B-3101 to B-3104)

- New permissions `calendars:read`, `calendars:write`, `contacts:read` and `contacts:write` (members and tenant
  admins). Migration `032_dav`. Described in `docs/dav.md`.
- App passwords for DAV clients under `/api/me/app-passwords` (list, create, revoke): per device, shown once, with
  DAV-only scopes (`caldav`, `carddav`, `webdav`) and an optional expiry; creating one needs a second factor confirmed
  within the step-up window (a TOTP or passkey step-up now records the factor on the session); the list shows the last
  use. They authenticate `/dav` only (HTTP Basic over TLS) and are refused by `/api`, `/v1` and the console (B-3101).
- The WebDAV core at `/dav` with `/.well-known/caldav` and `/.well-known/carddav` discovery: PROPFIND, PROPPATCH (all
  or nothing; dead properties sealed), REPORT, ETags with `If-Match`, `If-None-Match` and the If header (a stale ETag is
  412), `sync-collection` (RFC 6578), strict XML parsing (no DOCTYPE or entities, size and depth caps), its own rate
  limit and failed-credential limits (B-3101).
- CalDAV over personal calendars (MKCALENDAR, validated objects stored sealed with indexed time spans) and the
  calendars of one's groups: `calendar-query` with every RFC 4791 filter operator, `calendar-multiget`,
  `free-busy-query`; answering a group event from a client (its `PARTSTAT`) is written back as the RSVP, and
  moderators' edits and cancellations go through the groups service (B-3102). The iCalendar writer of B-2504 renders
  organisers and attendees and a METHOD-less object form.
- CardDAV: the directory as a read-only address book filtered by clearance (a contact above the caller's clearance is
  never returned), and personal address books (extended MKCOL, vCard 3.0 and 4.0), `addressbook-query` with every RFC
  6352 operator and `addressbook-multiget` (B-3103).
- A conformance run of Apple Calendar and Contacts, Thunderbird and DAVx5 exchanges (`server/test/fixtures/dav/`),
  replayed by the test suite; it fails when a filter operator is not exercised (B-3104).
- B-3104 stays partial: the fixtures were written from the clients' documented requests. Capturing real traffic
  (B-3606) was dropped by the owner on 2026-10-06 (not needed); it had been held because macOS 27 Calendar refuses Basic authentication over plain HTTP, and capturing over TLS
  needs a per-host certificate trust on the capturing Mac that was not approved.

### Import repositories and model import (Sprint 30, B-3801 to B-3803)

- New permissions `imports:run`, `imports:repositories` and `imports:review`, and a fourteenth built-in role,
  `legal-review` (granted only by a system admin), which decides licence exceptions and keeps the tenant's licence
  allow-list; tenant admins can request exceptions but not decide them. Migration `033c_imports`.
- Repository registry under `/api/imports/repositories`: Hugging Face compatible hubs, Ollama compatible registries,
  CKAN, DCAT-AP, SDMX, OpenML, InvenioRDM, Kaggle and the signed bundle share. A repository is proposed by one admin
  and confirmed by another before its hosts join the staging-proxy allow-list and it is harvested; credentials are
  vault references sent only to the repository's own host; harvests run on a schedule and back off when the source
  rate-limits. `GET /api/imports/proxy-allowlist` exports the allow-list for the staging proxy (B-3801).
- Catalogue browse with classification, licence, format and other facets from each source's own taxonomy; a facet's
  count is exactly what its filter returns; live search through the proxy when the source can be searched, the
  snapshot otherwise and while a source backs off (B-3802).
- Model import: plan (every check, nothing written), gate acceptance with the recorded token, format and pickle checks
  by name and by content, digests pinned at request time and checked after resumable downloads, licence policy with
  exceptions, GGUF conversion or packaging on the training pool (`POST /v1/convert` gains `source`), draft registration
  with the digest pinned and a signed import manifest; air-gapped instances queue requests for the weekly bundle and
  continue them when a promoted bundle carries the files. The Imports queue with cancel and resumable retry; a 500 GB
  dataset import quota per tenant, metered beside model imports (B-3803).

### Permission matrices and custom roles (Sprint 29, B-3301 to B-3305)

- New permission `roles:manage` (tenant admins). Migration `031_access`.
- Role × permission matrix generated from the catalogue: `GET /api/authz/matrix` (JSON, or CSV with `?format=csv`),
  with the tenant's custom roles and the routes of each permission. `docs/permissions.md` is generated from the same
  source (`npm run docs:permissions`); the test suite fails when it differs from the catalogue (B-3301).
- Custom roles per tenant under `/api/authz/roles`: built only from catalogue permissions the creator holds (a tenant
  admin cannot create a role holding `platform:manage`), with `grantableBy` and `requiresMfa` as for built-in roles; a
  role holding an admin permission is under dual control; every version is kept with a diff and audited
  (`authz.role.*`). Custom roles resolve wherever built-in ones do: assignment, group mappings, invitations, CSV
  imports, `GET /api/me`, the policy, effective permissions and `explain`, whose role step now names the granting
  roles (B-3302).
- Effective-access matrix `GET /api/authz/access` (users and their API keys × workspaces × permissions after scopes,
  clearance and zone ceilings), `explain` for any cell and "who can" for one permission; every cell is
  `policy.explain`'s decision (B-3303).
- Route permission registry `server/src/authz/routes.ts`: every route declares its permission, and a route without one
  fails the test suite; `requireAnyPermission` replaces the routes' own any-of helpers (B-3304).
- Access reviews under `/api/authz/reviews`: scheduled and repeating certification campaigns over direct role grants
  and workspace memberships. Each grant is assigned to its admins (the tenant admins, and for a workspace membership
  also the workspace's members holding `roles:manage`) and to the member's directory manager, never to the member;
  the first decision stands. A revoke is gone on the member's next request and their sockets leave the rooms it gave;
  overdue campaigns escalate once to the tenant admins; every step is in the audit chain (`authz.review.*`, the
  `authz.reviews` job) (B-3305).
- LDAP stores read the user's manager (`managerAttribute`, default `manager`) and SQL user tables an optional
  `columns.manager`; sign-in and directory sync keep it on the user's identity (`user_identities.manager_ref`).

### Record queries PostgreSQL answers from an index (Sprint 29, B-3601)

- Low-code record pages sorted on a value field are read in order from that field's value index and stop at the
  page; the filter's top-level conditions on the same field are tested on the index row, the count starts from one
  condition's index rows, and records are reached by primary key, so the plans hold before PostgreSQL has statistics
  for a freshly loaded entity (the cause of the 1.4.0 load test's miss). Empty values sort last with `NULLS LAST` on
  PostgreSQL and text compares and sorts with `COLLATE "C"`, as its indexes are built. SQLite, MySQL and PostgreSQL
  return the same rows in the same order (`server/test/integration/apps.test.ts`, now also paged by cursor and by
  offset). Migration `031b_record_queries`: the value indexes gain the record id (on PostgreSQL collated and partial).
- Keyset paging: record listings and queries answer `nextCursor`; send it back as `cursor` for the next page.
  `offset` still works (not together with a cursor). The CSV export pages by cursor and counts once.
- Formula sorts put numbers before text on every dialect (PostgreSQL put text first when descending, SQLite and MySQL
  when ascending), and text range filters on `state` compare bytes on PostgreSQL too.
- Platform load test on PostgreSQL: records query p95 65 and 62 ms in two full runs (732 ms at release), every target
  met; 67 ms with autovacuum off. The records scenario reports each query body's p95 and signs in 128 users (64 hit
  the per-user API limit once queries got faster). `docs/loadtest.md`.

### MongoDB data connections (Sprint 30, B-3602)

- `engine: mongodb` on `POST /api/admin/connections`, merged from `feat/mongodb-connections`. Reads are `find` and
  `aggregate` only, written as JSON; writes, DDL, `$out`, `$merge`, server-side JavaScript (`$where`, `$function`,
  `$accumulator`, Code values, `mapReduce`) and stages off a read-only list are refused before anything is sent and
  checked again in the driver. Collections read through `$lookup`, `$graphLookup` and `$unionWith` must be on the
  allow-list (names or patterns such as `orders_*`); `system.*` and other databases are refused. Reads use the
  connection's row limit (plus one, to report capping) and timeout (`maxTimeMS`), mask personal fields inside
  sub-documents too, and are audited as for the other engines.
- One direct connection to the checked address (no replica-set discovery or SRV), no retries, credentials as options
  (sealed, or a `vault:` reference). The account authenticates against the connection's database unless the
  username is `<authdb>/<user>`. Test connection reports an account with write privileges, or a server without
  authentication, as `degraded`. OpenBao dynamic credentials stay PostgreSQL and MySQL only (`409`).
- Collections as knowledge sources (`kind: database`): `fields` to index (by default the text fields of the sampled
  schema), `idColumn` (`_id`), a watermark field (`updatedAt` or `updated_at` when sampled), and an access field as for
  B-1002. No migration; the metadata is tested on SQLite, PostgreSQL and MySQL (`TEST_MONGODB_URL` gates the
  real-server test; CI runs a `mongo:8` service).
- Dependency: the official `mongodb` driver 7.7.0 (pinned).

## 1.4.0

### AT-Protocol firehose ingest (Sprint 27, B-1908)

- AT-Protocol firehose ingest (B-1908, Sprint 27): per-tenant subscriptions to a Jetstream or a relay's
  `com.atproto.sync.subscribeRepos` under `/api/atproto/firehose` (new permission `firehose:manage`, held by tenant and
  guardrail admins), with collection and author allow-lists and deterministic sampling. Posts go through the
  moderation check and their verdicts become flags and signed labels from the tenant's labeler. Each consumer runs on
  one worker instance through a lease, stores its cursor periodically and at shutdown and resumes from it after a
  restart, pauses its socket when its queue is full, and reconnects with backoff. Migration `029b_firehose`; settings
  `FIREHOSE_*`; metrics `exprsn_firehose_*`; audit actions `atproto.firehose.*`.

### Low-code data apps (Sprint 27, B-2201 to B-2208)

- Apps per tenant or workspace with entities of typed fields (string, number, boolean, date, enum, reference, lookup,
  file, JSON, formula, AI), validation and uniqueness; a duplicate unique value is refused on SQLite, PostgreSQL and
  MySQL (`server/test/integration/apps.test.ts`). New permissions `apps:design` (workflow and tenant admins),
  `records:read` and `records:write` (members and tenant admins). Migration `029_apps`.
- Records sealed with the tenant key, with CRUD, filters, sorts, search, pagination, aggregation, all-or-nothing bulk
  writes, and CSV import and export as jobs. Fields a designer marks `indexed` are also kept in a normalised clear
  index, so the same filter returns the same rows in the same order on all three databases; the choice and what it
  exposes are in `docs/security.md`.
- Lookups (static, entity, user, workspace) and formula fields from a parser that walks a tree (no `eval`, no
  property access, a fixed list of functions), so a formula cannot reach a global.
- A state machine per entity: illegal transitions are refused, transitions are audited and emitted as
  `record.transitioned`. The `record.*` events are now emitted (catalogue version 3).
- Forms with conditional fields; public forms (a link token, at `/api/public/forms`) keep only the fields they list
  and show, are rate-limited per address and per form, and pass the `user-input` guardrail.
- Record-event and schedule triggers start published workflows as their owner, and workflows have a `record` step that
  creates, updates or moves records; chains stop at `APPS_TRIGGER_MAX_DEPTH`.
- AI fields filled from a profile prompt by a job, failing soft (a model error leaves the field empty and the record
  saved), and natural-language drafts of entities and workflows from a local model, validated and never saved.
- Apps export and import as bundles signed with a KMS HMAC key; a tampered bundle is refused. Records are moderation
  objects.

### Groups and events (Sprint 27, B-2501 to B-2505)

- Groups inside a workspace (`/api/groups`): public, private or hidden; open, request or invitation-only joining;
  join requests and invitations that expire (`GROUP_REQUEST_DAYS`, `GROUP_INVITE_DAYS`); owner, moderator and member
  roles. Workspace membership is the outer boundary: a user outside the workspace cannot see, join or be invited to
  its groups. New permissions `groups:read` and `groups:write` (members) and `groups:manage` (tenant admins).
- Group events with IANA time zones (stored as UTC plus the zone), RSVPs with guests and capacity, attendee lists and
  check-in. Cancelling an event notifies every attendee in the console and by email (the new `event-notice` template).
- Reminders as `calendar.reminder` queue jobs at their time, sent in the console and by email, once across instances.
- Signed iCalendar feeds per event, group and user at `/calendar/feeds/<id>/<signature>.ics` (RFC 5545, HMAC with a
  derived key, revocable); events above `CALENDAR_FEED_MAX_LABEL` show as busy time.
- Group posts (sealed, screened at `user-input`) and group, post and event moderation through the moderation API:
  a report on a group post makes a flag in the workspace queue, and moderators see their group's cases.
- The `group` realtime room kind; catalogue version 3 emits `group.*` events (members, posts, events).
- Migration `029c_groups`; new settings `GROUP_INVITE_DAYS`, `GROUP_REQUEST_DAYS`, `CALENDAR_FEED_PER_MINUTE`,
  `CALENDAR_FEED_MAX_LABEL`.

### Customer-service channels and email one-time codes (Sprint 28, B-2301 to B-2304, B-1806)

- Chat channels (B-2301): a channel in a workspace answers customers with a published profile or agent (prompt and
  profile; never its tools) at the channel's label, checked against the workspace ceiling and the profile's and agent's
  labels when saved and enforced by the gateway's pool ceilings when answering. Customers use the public endpoints at
  `/api/public/channels` anonymously or with an identity assertion the channel's site signs (an identified customer
  resumes their open session), with a session token scoped to one session, and rate limits per address and per session.
  Every customer message passes `user-input` and every answer `model-output`; a model failure tells the customer a
  person will follow up and escalates the session. New permissions `channels:manage` (tenant admins) and
  `channels:review` (tenant and guardrail admins, flag reviewers). Migration `030_channels`.
- Held replies (B-2302): answers wait for a reviewer when the channel reviews every answer, when it reviews escalated
  sessions (the default) and the customer asked for a person, or when a guardrail requires approval. Each is a `hold`
  flag; a reviewer approves, edits or rejects it (`/api/channels/held`, or approve and reject in the flag queue), and
  only then does the customer receive it, as edited (the model's text is kept as the original).
- Email channels (B-2303): inbound by IMAP polling (one `channels.imap-poll` job per channel per tick, read-only,
  with a UID cursor) and by signed webhooks (a generic JSON shape with an HMAC header per channel, and Mailgun routes
  and events); threaded into sessions by Message-ID together with the sender's address; answers from an outbox of
  `channels.send` jobs over the channel's SMTP server or `SMTP_URL`, with `In-Reply-To`, `References` and
  `Auto-Submitted`; bounces from delivery reports and provider events recorded once and marked on the outbox. Mail
  credentials are vault references. New dependencies: `imapflow` and `mailparser` (and `@types/mailparser`).
- Retention and exports (B-2304): per-channel retention in days with a `channels.retention` purge job; transcripts as
  CSV per session, or a whole channel through a `channels.export` job sealed in the blob store.
- Channel sessions and messages are moderation object types (`channel-session`, `channel-message`). Event catalogue
  version 4: `channel.*` events are emitted. Settings `CHANNELS_*`.
- Email one-time codes as a second factor (B-1806): enrol the account's address with a code
  (`POST /api/me/mfa/email`), then `POST /api/auth/mfa/email/send` and `POST /api/auth/mfa/email` at sign-in. Codes
  are HMAC-stored, single use, bound to the pending session, sent at most `MFA_EMAIL_SENDS_PER_HOUR` times an hour,
  and wrong codes count in the same lockout as TOTP codes: a sixth wrong code is refused like a sixth wrong TOTP code.

### Social relations and messaging (Sprint 28, B-2601 to B-2606)

- Social relations shared by messaging and the workspace feed (`/api/social`, `server/src/social/`): blocks that work
  in both directions and end follows both ways, private mutes that may expire, follows and lists inside the workspaces
  two people share, and a contact rule per user (everyone in my workspaces, people I follow, or nobody). A block
  refuses with the same words as a contact rule, so the blocked person is not told. Room events raised through
  `SocialService.emitToRoom` leave out everyone in a block with the actor on every instance (the platform's BUG-080).
  New permissions `social:read` and `social:write` (members and tenant admins) and `social:manage` (tenant admins, an
  audited view of anyone's relations); audit actions `social.*`; catalogue version 4. Migration `030b_social`.
- Person-to-person messaging (`/api/messaging`, `server/src/messaging/`), sealed at rest with the tenant key (no
  end-to-end encryption, so search and summaries work). Direct conversations, one per pair even when both start one at
  once, and group conversations in a workspace with owner, admin and member roles; workspace membership stays the
  outer boundary. New permissions `messages:read` and `messages:write` (members and tenant admins).
- Send, edit, delete, reply, threads, reactions, pins and forwarding; edits and deletes are audited without the text,
  and a deleted message keeps only a tombstone. The `message.sent`, `message.edited` and `message.deleted` catalogue
  events are now emitted; audit actions `messaging.*`. Messages are a moderation object type (`dm-message`).
- Delivery and read receipts, typing and presence in the `conversation` realtime room, through the new `room.signal`
  client message and room presence hooks; every event from a person leaves out the people in a block with them, on
  the socket as well as in the API.
- Attachments from the file store once they passed its quarantine; a mute and a notification rule (all, mentions,
  none) per conversation: a muted conversation sends no notification.
- Keyword search (keyed-hash terms) and semantic search (`MESSAGING_EMBED_MODEL`, by job) in a conversation; thread
  summaries and catch-up digests from a profile, citing only messages the reader can see.
- New settings `MESSAGING_MAX_MEMBERS`, `MESSAGING_EMBED_MODEL`, `MESSAGING_SUMMARY_PROFILE`,
  `MESSAGING_SUMMARY_MAX_MESSAGES`, `ROOM_SIGNALS_PER_MINUTE`; the messaging tables are in migration `030b_social`.

### Workspace feed (Sprint 28, B-2701 to B-2705)

- A feed for a workspace or a group (`/api/feed`, `server/src/feed/`): posts with media from the file store (only
  files that passed quarantine; they raise the post's label), threaded comments, reactions, plain and quoted reposts
  that stay in the original's workspace and group, and bookmarks. Bodies, comments and digest summaries are sealed
  with the tenant key. A comment, reaction or repost on a deleted post is refused (`409`). New permissions
  `feed:read` and `feed:write` (members and tenant admins) and `feed:manage` (tenant admins); audit actions `feed.*`.
  Migration `030c_feed`.
- Home (the caller and the people they follow), workspace, group, user, list, hashtag and bookmark feeds with cursor
  pagination. The relations are the shared ones of `/api/social`: a muted author leaves the home feed; a block,
  either way, hides posts, comments and reposted originals in every feed and refuses comments, reactions and reposts.
- Realtime: the `feed` room kind (a workspace, a group, or one's own home room). A new post reaches open feeds without
  a reload, as ids only, leaving out people below its label and everyone in a block with the author; followers' home
  rooms get it up to `FEED_HOME_FANOUT_MAX`.
- Posts pass the `user-input` guardrail checkpoint before publishing: a held post waits in the Flags queue (a `hold`
  flag), invisible to everyone but its author until a reviewer approves it, and stays invisible when rejected. Posts
  and comments are moderation object types (`feed-post`, `feed-comment`). The `post.*` catalogue events are now
  emitted (catalogue version 5, with the `feed.*` group for the audit actions).
- Hashtags extracted at publishing and counted by the `feed.trending` job per workspace and label (a reader sees only
  what their clearance reaches); a weekly workspace digest (`feed.digest`) of the week's top posts, ranked by
  reactions, comments and reposts and summarised by a profile through the gateway, with per-workspace settings.
  Settings `FEED_*`.
- Group feeds are feed posts targeted at the group; the group notices of Sprint 27 (`/api/groups/:id/posts`) stay as
  they are.

### Load test of the event and data paths (Sprint 28, B-2105)

- `server/loadtest/platform.ts` (`npm run loadtest:platform`): webhook fan-out with a hanging endpoint, low-code record
  writes and queries, OCSP (signed and cached) and firehose ingest from a fake Jetstream with a dropped connection and
  a restart, against the application in its own process with the signer as a process, on SQLite or an empty
  PostgreSQL or MySQL database. Targets, the reference setup and the measured results are in `docs/loadtest.md`; CI
  runs the scenarios with the looser `ci` targets next to the streaming load test. `npm run loadtest` runs the
  streaming load test.
- Fixed: the database job queue (`JOB_QUEUE=db`) waited for its whole batch at every poll, so it ran at most
  `JOB_CONCURRENCY` jobs per `JOB_POLL_MS` and one slow job held the other slots idle (webhooks measured 2.9 deliveries
  a second with p95 21.7 s). It now fills a slot as soon as a job finishes and starts a job queued on the worker at
  once when a slot is free (100 deliveries a second, p95 under 10 ms on the reference setup).
- Fixed: webhook attempts failing at the same time each wrote the failure count they had read, so the breaker opened
  late, could be closed again by a stale failure, and announced its opening more than once. The count now goes up in
  the database and only the attempt that changes the breaker's state announces it. While its breaker is still closed,
  an endpoint whose last attempt failed gets at most half the job slots of an instance, so it cannot starve the
  other endpoints.

## Unreleased

### Fixed

- Registry tool schemas are checked and validated in the JSON Schema dialect they declare with `$schema`: draft-07
  (the default), 2019-09 or 2020-12. MCP servers such as Context7 send 2020-12 schemas, which failed before. An
  unknown dialect is reported as a schema problem.
- `OLLAMA_LOAD_TIMEOUT_MS` (default 5 minutes, as before) sets how long chat and embedding requests wait for Ollama's
  first response, which includes a cold model load. Raise it for large models on slow storage.
## Unreleased

### Fixes

- A workspace whose ceiling is `public` could not start a conversation: when no label was given, a new conversation
  (and compare, and `/v1` without `X-Data-Label`) was always `internal`, which is above that ceiling, so every message
  was refused with "Label above this profile ... Pick a profile cleared for this label", which no profile could fix.
  The default is now `internal`, or the workspace's ceiling when that is lower. When the workspace ceiling is what
  refuses a message, the problem carries `ceiling: workspace` and the console says so. Test in `chat.test.ts` (fails
  on the old code with the same 403).

## 1.3.2

Follow-ups from reviewing 1.3.1 and its CI run.

### Fixes

- Shared rate limits: 1.3.1 made a hit wait up to 250 ms for Redis's first connection, but only "until Redis has
  answered once", so with Redis unreachable from the start every API request would have waited 250 ms for as long as
  it stayed down. The wait now applies only in the first five seconds after start; after that a hit falls back to
  memory at once, as during any outage. Test: `ratelimit-connect.test.ts` (fails without the fix: five hits took
  1.25 s).
- Console suite: the dialog and drawer reflow check (B-1507) gave up on a screen whose controls had not rendered yet
  and then reported it as "no dialog opened" (Platform, on a loaded CI runner). It now waits up to five seconds for a
  screen's controls before concluding it has none.

## 1.3.1

CI on `main` had been red since the pre-1.0 review fixes: the integration and load-test jobs failed on every run. The
unit suite and the console suite were green throughout, which is why it went unnoticed.

### Fixes

- SQL user stores (PostgreSQL, MySQL) could not connect at all since 1.2.0. The per-connection host check of B-809 used
  Knex's `expirationChecker`, which made the pool re-resolve its settings on every acquire and never hand out a
  connection. The check now runs inside the stream the driver asks for, once for each new connection, and dials the
  address that check returned, so the DNS-rebinding protection of B-809 is unchanged.
- Shared rate limits (B-406) never shared anything for a fresh connection: the Redis client refuses commands until it
  is connected (its offline queue is off so that an outage falls back at once), so each instance counted its first
  requests, and a new counter store all of them, in memory. Until Redis has answered once, a hit now waits up to
  250 ms for it; outages still fall back to memory at once.
- The OpenLDAP integration tests set their own secret-reference policy (`SECRET_REF_ENV` from the pre-1.0 review
  refuses every reference until one exists).
- The CI load test's fake answers now end a sentence every 12 words. Since 1.1.0 output is screened a sentence at a
  time, and fake answers with no sentence end were only released at the 240-character fallback, so the job measured
  the fake text rather than the platform (p95 time to first token 465 ms without sentence ends, 120 ms with, measured
  in-process with the CI settings; the 500 ms budget is unchanged).

## 1.3.0

Sprints 20 to 23: the [1.3.0 backlog](Backlog-1.3.0.md), which keeps key material out of the application, adds the
operational features a production install still lacked (tracing, dashboards and alerts, safe upgrades, key escrow) and
deepens AI, knowledge and integrations. This release line starts from `main` with 1.2.0 and the dependency fixes (PR
#20: otplib 13 through `server/src/identity/totp.ts`, `@types/node` 26, TypeScript 7). Sprint details are in
[Sprints.md](Sprints.md); the remaining gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md)
(now 56 groups met, 8 partly, 7 not applicable) and [docs/accessibility.md](docs/accessibility.md).

### Keys and supply chain
- An optional signer process (`exprsn-ai signer`, `SIGNER_SOCKET`) holds the local key-encryption key and every OIDC,
  SAML, SAML SP decryption and webhook private key, and signs and decrypts over a token-checked UNIX socket; with it the
  application holds no private key and no key-encryption key. A systemd unit (`deploy/baremetal/exprsn-signer.service`)
  and a Helm sidecar (`signer.*`) run it as its own user.
- Webhook Ed25519 keys are made and used in OpenBao transit or the signer; keys sealed before stay published.
- HTTP Message Signatures (RFC 9421, with RFC 9530 `Content-Digest`): an API key may register an Ed25519 public key,
  after which `/v1` accepts only signed requests from it; webhooks can add RFC 9421 signatures (HMAC-SHA256 or
  Ed25519).
- Production refuses `DATA_KEY`, `DATA_KEY_PREVIOUS` and `SIGNER_TOKEN` given inline in the environment; with the
  signer it refuses `DATA_KEY` from any source.
- CI runs `npm audit signatures`; on `main` and `v*` tags it pushes the image to GHCR with a SLSA build provenance
  attestation and a keyless cosign signature, verifies both, and attaches the SBOMs to the release. These steps were
  validated with actionlint and a YAML parse only and have not yet run on GitHub; they assume the image is
  `ghcr.io/<owner>/<repo>`.

### AI
- A `/v1` request sent with an API key that `require-approval` stops answers `202` with a held-request id; another
  reviewer approves it in Flags and the client fetches the answer from `GET /v1/held/:id`. Compare holds the prompt and
  every column.
- `POST /v1/responses` and `GET /v1/responses/:id`: a documented subset of the Responses API with streaming events and
  function tools; `store: true` (off by default) saves the exchange to Chat, and `previous_response_id` continues it.
- Evaluations per profile (contains, regex, JSON schema, a judge rubric), scored per profile version; a profile version
  whose gated eval sets do not pass cannot be published unless a second profile admin approves an override. The
  Profiles screen gains an Evaluations tab.
- The full `model-output` check covers thinking as well as the answer.
- A reader removed from a shared workspace (by an admin, a group mapping or directory sync) loses an open watch at once.
- Scheduled agent runs: UTC cron schedules on agents, run as the owner with their current roles, with a run history;
  each due time runs once across instances.

### Operations
- OpenTelemetry tracing over OTLP/HTTP (`OTEL_EXPORTER_OTLP_ENDPOINT`) for requests, jobs, Ollama calls, guardrail
  checks and database queries, with an attribute allow-list and no tenant content.
- Prometheus recording and alert rules with promtool unit tests, and overview and operations Grafana dashboards, in
  `deploy/observability/`; the alerts runbook is [docs/runbooks/alerts.md](docs/runbooks/alerts.md).
- `migrate --check` lists pending migrations and their destructive steps. An instance older than the database schema
  stops taking jobs, reports not ready (`/readyz` 503 with `checks.schema`) and refuses to start. Migrations follow an
  expand/contract rule, linted by a test.
- `kms:escrow` splits the local key-encryption key into k-of-n Shamir shares (`--key-file` takes the signer's key file),
  and `kms:recover` rebuilds it into a new 0600 file.
- `ZONES_APPLY=kubernetes` applies each zone's NetworkPolicy with server-side apply and reports drift.
- `NTP_SERVER` takes several servers; the reported skew is their median, with outliers named.
- A Redis outage that leaves rate limits counting per instance shows on Platform and as the
  `exprsn_ratelimit_degraded` metric and alert.

### Knowledge and integrations
- S3-compatible bucket sources with their own endpoint and sealed keys, include patterns and ETag change detection.
- An internal web crawler: same origin, robots.txt and sitemaps, depth and page limits, conditional re-fetch.
- PostgreSQL row security for database sources: reads run as a mapped database role per group.
- Ordered webhook delivery across instances, with a position counter and a delivery lease per endpoint.
- Price book versions prorate mid-month price changes; Stripe refunds, credit notes and disputes are reconciled.

### Accessibility
- axe-core 4.13.0 runs beside the in-page checker on every screen and design state, sign-in and a streaming chat, in
  Standard and Enhanced (with AAA contrast), light and dark; any violation fails the suite.
- Dialogs and drawers are checked for reflow at 320 and 640 px.
- Fixed: a Profiles hint link below the 24 px target size, the unlabelled workflow picker on Workflows, and a long
  breadcrumb that pushed the page sideways at 640 px and below.

### Testing
- 532 unit and API tests (1 skipped) across 42 files, with new suites `sprint20.test.ts`, `sprint21.test.ts`,
  `sprint22-ops.test.ts`, `sprint23-knowledge.test.ts` and `sprint23-integrations.test.ts`, and fakes for an OTLP
  collector, the Kubernetes API, SNTP and Redis (`sprint22-fakes.ts`) and for an S3 bucket and a web site
  (`sprint23-fakes.ts`).
- `integration/rls.test.ts` (row security by role) and `integration/webhooks.test.ts` (ordered delivery across
  instances) against PostgreSQL.
- 57 Playwright tests, with axe-core in `y-accessibility.spec.ts` and the new `y-reflow-overlays.spec.ts`.
- A CI job checks and unit-tests the Prometheus rules with promtool.

### Upgrade notes
- Migrations `022_keys` to `025_integrations3` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- Production refuses `DATA_KEY`, `DATA_KEY_PREVIOUS` and `SIGNER_TOKEN` given inline in the environment. Give them as
  files (`DATA_KEY_FILE`, `DATA_KEY_PREVIOUS_FILE`, `SIGNER_TOKEN_FILE`) before upgrading.
- The signer is optional. To use it, run `exprsn-ai signer` as its own user with the old `DATA_KEY` as its key file (no
  re-wrap is needed), then remove `DATA_KEY` and `DATA_KEY_FILE` from the application and set `SIGNER_SOCKET` and
  `SIGNER_TOKEN_FILE`: on bare metal with `deploy/baremetal/exprsn-signer.service` and the commented lines in
  `exprsn-ai.service`, in Kubernetes with the chart's `signer.enabled`. Turning it on replaces the federation signing
  keys: SAML service providers re-import the IdP metadata.
- An instance whose build is older than the database schema now stops taking jobs and reports not ready. For a rolling
  upgrade, run `exprsn-ai migrate --check` first: expand-only migrations (all of 1.3.0's) keep the previous release
  working while instances are replaced; a contract step needs every old instance stopped first
  ([docs/runbooks/upgrade.md](docs/runbooks/upgrade.md)).
- Publishing a profile version that has gated eval sets now answers `409 eval_gate` until they pass or a second profile
  admin approves an override. Profiles without gated sets publish as before.
- New settings, all optional with safe defaults: signer and signatures (`SIGNER_SOCKET`, `SIGNER_TOKEN_FILE`,
  `SIGNER_TIMEOUT_MS`, `HTTP_SIGNATURE_MAX_AGE_SECONDS`; in the signer `SIGNER_KEY_FILE`, `SIGNER_SOCKET_MODE`,
  `SIGNER_ALLOW_GROUP_READ`), scheduled agents (`AGENT_SCHEDULE_TICK_SECONDS`), tracing (`OTEL_EXPORTER_OTLP_*`,
  `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_BSP_*`), upgrades (`SCHEMA_CHECK_SECONDS`), zones
  (`ZONES_APPLY`, `ZONES_APPLY_*`), time and rate limits (`NTP_OUTLIER_MS`, `RATELIMIT_PROBE_SECONDS`; `NTP_SERVER`
  takes a list) and knowledge (`KNOWLEDGE_ALLOWED_HOSTS`, `KNOWLEDGE_FETCH_TIMEOUT_MS`). See
  [docs/deploy.md](docs/deploy.md).
- The e2e package adds `axe-core` to its devDependencies; run `npm ci` in `e2e/` again.
- No new permissions.

## 1.2.0

Sprints 16 to 19: the [1.2.0 backlog](Backlog-1.2.0.md), which closes most of the known gaps and ASVS follow-ups left
after 1.1.0 and deepens chat, knowledge and integrations. Sprint details are in [Sprints.md](Sprints.md); the remaining
gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md) (now 54 groups met, 10 partly, 7 not
applicable) and [docs/accessibility.md](docs/accessibility.md).

### Chat and AI
- `/v1` takes chat's knowledge and memory context on request (`X-Exprsn-Knowledge`, `X-Exprsn-Memory`) under chat's
  clearance rules, with citations in an `exprsn` extension field, and runs the profile's read-only tools on the server
  (`X-Exprsn-Tools: profile`); each header needs its own permission or scope.
- The guard model and classifiers check streamed answers in the background; with a hold-back
  (`CHAT_GUARD_HOLDBACK_SENTENCES`, 1) a sentence is shown only once a clean verdict covers it. Tool results shown in
  chat pass the stream screen.
- `require-approval` on `user-input` holds the prompt in the Flags queue until a reviewer approves or rejects it.
- Readers of a shared conversation watch answers stream, and lose them at once on revocation.
- Anonymous share links, off per tenant by default, for conversations labelled `public` only, expiring,
  rate-limited and audited, opened on a signed-out page.
- Retention per workspace and per user; the shortest applicable period wins.
- Prompt templates pass the `user-input` guardrail checkpoint when saved and published.

### Identity and security
- A sign-in from a new browser or a new network sends a security notice (`SIGNIN_NOTICES`, on by default).
- A password strength meter on every password form; Platform warns while the breached-password check is off.
- Re-authenticating at an upstream OIDC or SAML IdP counts as step-up.
- Admin password reset revokes the account's API keys unless the option is unticked.
- Optional DPoP nonces (`DPOP_NONCES`) and `API_PUBLIC_URL` for proofs behind a proxy prefix.
- Resource servers may introspect any client's token after a second identity admin approves.
- SAML: optional whole-response signing; SP and IdP metadata fetched by URL, refreshed daily, with certificate and
  endpoint changes held for approval.
- Console sign-out runs front-channel logout; SQL user stores dial the checked address.
- `admin:create --enrol-link` gives the first admin a single-use link that sets the password and enrols a factor.
- Operator-chosen service URLs (pool instances, zone endpoints, image backends, the trainer) refuse metadata,
  link-local and unspecified addresses when saved and at every connection (`SERVICE_ALLOWED_HOSTS`,
  `SERVICE_INTERNAL_ONLY`).
- `REQUIRE_BACKEND_TLS` refuses plaintext PostgreSQL, MySQL, Redis, S3 and OpenBao links in production (off by
  default; `BACKEND_TLS_EXEMPT` per link).
- YAML size, depth, node and alias caps; secrets masked in diagnostics and problem details.
- Training data leaves the platform sealed with a per-run key (worker contract 2); checkpoints and GGUF files come back
  sealed under the tenant key.
- `kms:rewrap` also re-signs image provenance and training model cards.

### Accessibility
- The Playwright suite checks every screen and design state, sign-in and a streaming chat, light and dark, against an
  in-page checker modelled on axe-core's WCAG A/AA rules (Standard mode).
- No two-dimensional scrolling at 320 and 640 px; wide tables scroll in a named, keyboard-reachable region.
- One tab panel per tab list; faint text at 4.5:1 or more; no nested buttons in Pools rows; Media caption contrast.

### Platform and operations
- Backups read one snapshot, and the blob archive holds exactly the objects it names.
- ACME external account binding, RFC 2136 over TCP with fallback and SOA zone discovery, and push hooks per
  certificate (named reload commands or signed webhooks).
- MCP servers and connections outside their zone are listed with a move proposal under dual control.
- Promoted artefacts are pushed to Harbor, Verdaccio and devpi.
- `API_RATE_PER_MINUTE` sets the `/api` limit per user (600 by default).

### Knowledge and integrations
- MySQL tables and views as knowledge sources.
- Row-level access for database knowledge sources from an access column, enforced at retrieval.
- PostgreSQL logical replication for knowledge sources (`KNOWLEDGE_REPLICATION`), falling back to watermarks.
- Ordered webhook delivery per endpoint, and Ed25519 signatures with a per-tenant key published as a JWKS.
- Per-tenant price books, currency and taxes; a signed Stripe webhook marks statements paid, failed or void
  (`STRIPE_WEBHOOK_SECRET`).
- A paused workflow tool gives an agent run a pending result it awaits; approval timeouts per step; run events reach
  approvers live.
- `IMAGE_SAFETY_REQUIRED` withholds images no classifier checked; `SCRIPT_RUNTIME=runsc` runs scripts under gVisor.

### Testing
- 477 unit and API tests (1 skipped) across 37 files, with new suites `sprint16.test.ts`, `sprint17.test.ts`,
  `sprint18.test.ts`, `sprint19-knowledge.test.ts`, `sprint19-integrations.test.ts` and `sprint19-workflows.test.ts`,
  and fakes for Harbor, Verdaccio and devpi (`sprint18-fakes.ts`).
- `integration/replication.test.ts`: logical replication against PostgreSQL with `wal_level=logical`.
- 55 Playwright tests, with new specs `shared.spec.ts`, `password-meter.spec.ts`, `y-accessibility.spec.ts` and
  `y-reflow.spec.ts`.
- A flake in `memory.test.ts`, where a random sealed value could contain the searched substring, is fixed.

### Dependencies

- Builds on the dependency updates merged into `main` after 1.1.0: TypeScript 7, `@types/node` 26, otplib 13,
  undici 8, and the PostgreSQL 18, Redis 8 and MySQL 9.6 images. otplib 13 drops the `authenticator` API; TOTP now
  goes through `server/src/identity/totp.ts` (the same SHA-1, six-digit, 30-second codes with one step of drift, so
  enrolled authenticators keep working; checked against the RFC 6238 vectors). `@types/node` 26 keeps the JWK type
  under `crypto.webcrypto`.

### Upgrade notes
- Migrations `018_chat_depth` to `021_integrations2` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- The training worker must speak contract 2 ([docs/training-worker.md](docs/training-worker.md)). A contract-1 worker
  is refused unless `TRAINER_PLAINTEXT_FALLBACK=true`, which sends rows in plaintext as before.
- The integration tests need PostgreSQL with `wal_level=logical`; CI sets it with `ALTER SYSTEM` and a restart. Add the
  same step to other pipelines that run `npm run test:integration` against PostgreSQL.
- The `/api` rate limit is now `API_RATE_PER_MINUTE` (600 a minute per user, or per address when signed out, as
  before); raise it for automation that makes many console requests.
- Admin password reset now revokes the account's API keys by default; untick the option to keep them.
- New-sign-in notices are on by default (`SIGNIN_NOTICES=true`). Each account's first sign-in after the upgrade only
  records its browser and network; a later sign-in from another browser or network sends a notice. Set it to `false`
  to turn them off.
- New settings, all optional with safe defaults: chat (`CHAT_GUARD_HOLDBACK_SENTENCES`, `CHAT_GUARD_STREAM_CONCURRENCY`,
  `SHARE_ANONYMOUS_PER_MINUTE`), identity (`SIGNIN_NOTICES`, `DPOP_NONCES`, `DPOP_NONCE_SECONDS`, `API_PUBLIC_URL`,
  `FEDERATION_METADATA_REFRESH_HOURS`), outbound and backend links (`SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`,
  `REQUIRE_BACKEND_TLS`, `BACKEND_TLS_EXEMPT`), ACME (`ACME_EAB_KID`, `ACME_EAB_HMAC_KEY`,
  `ACME_DNS_RFC2136_TRANSPORT`, `ACME_RELOAD_COMMANDS`, `ACME_HOOK_TIMEOUT_MS`; `ACME_DNS_RFC2136_ZONE` is now
  optional), training (`TRAINER_*`), knowledge (`KNOWLEDGE_REPLICATION`, `KNOWLEDGE_REPLICATION_TICK_MS`), billing
  (`STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS`), `IMAGE_SAFETY_REQUIRED`, `SCRIPT_RUNTIME` and
  `API_RATE_PER_MINUTE`. See [docs/deploy.md](docs/deploy.md).
- No new permissions.

## 1.1.0

Sprints 11 to 15: the [1.1.0 backlog](Backlog-1.1.0.md), which closes most of the known gaps and ASVS follow-ups of
the release candidate and adds the platform features the 1.0 review found missing. Sprint details are in
[Sprints.md](Sprints.md); the remaining gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md)
(now 50 groups met, 14 partly, 7 not applicable) and [docs/accessibility.md](docs/accessibility.md).

### Account and security
- Password change for local accounts in Settings: the current password is required, reuse is refused, and every other
  session and OAuth grant ends.
- Admin password reset (a temporary password or an emailed single-use link) and email invitations; admin-set and reset
  passwords must be changed at the next sign-in, after the second factor.
- Password reset by email from the sign-in screen: the same answer whether or not the account exists, a single-use
  token stored as a digest, throttled; a reset ends sessions and grants and lifts a lockout.
- Breached-password check against the HIBP range API (only a five-character prefix leaves) or an offline file
  (`BREACHED_PASSWORDS`, off by default).
- Step-up re-authentication for creating API keys, removing factors and regenerating recovery codes
  (`STEPUP_WINDOW_SECONDS`).
- Security notices in the console and by email for password, factor, recovery-code, API-key, session and grant
  changes and admin resets; plain-text and HTML email templates with every value escaped.

### Chat
- Output guardrails while an answer streams: text is released a sentence at a time, after the deterministic
  `model-output` rules have screened it; a block stops the model.
- `require-approval` on an answer holds it for review in the Flags queue until a reviewer approves or rejects it.
- Resumable streams across instances: a client catches up from any instance, and an interrupted answer can be
  continued.
- Agent memory write-back through the memory checkpoint, under each agent's memory policy.
- Citations keep the quoted passage; Sources show it within the reader's clearance.
- Conversation retention per tenant, purged by the `chat.retention` job and audited.

### Integrations
- OpenAI-compatible API at `/v1` (models, chat completions with streaming and tools, embeddings) with the same
  profiles, clearance, quotas, guardrails and metering as chat; OAuth tokens scoped `inference:invoke:<profile>` are
  bound to those profiles.
- Signed webhooks for audit actions, job states, flags and approvals, delivered as jobs with retries and a
  per-endpoint breaker, with a delivery log and replay; per-tenant allowed hosts for webhooks and workflow HTTP steps.
- Prompt library of versioned templates with variables, per workspace or tenant, with a picker in chat.
- Read-only conversation sharing with a person, a workspace or an expiring link; Markdown and JSON conversation export.
- Billing: price books, monthly statements from the usage meter, CSV and JSON export, and an optional Stripe invoice
  push.

### Federation
- Connected applications in Settings: users see and remove the applications they allowed.
- Access-token revocation (RFC 7009) through a shared deny-list, and introspection (RFC 7662).
- RP-initiated, front-channel and back-channel logout; `prompt=login` and `max_age`.
- Pushed authorization requests and signed request objects; DPoP sender-constrained tokens.
- SAML single logout in both directions, and encrypted assertions (AES-GCM with RSA-OAEP).
- With OpenBao, OIDC and SAML signing in transit, so no private signing key is in the process.

### Operations
- Rate limits, a throttle on failed bearer credentials (20 a minute per address) and the denial cap share one atomic
  Redis counter across instances.
- `kms:rewrap` moves every data key, checkpoint signature and backup to a new `DATA_KEY` or KMS.
- ACME dns-01 through a signed webhook or RFC 2136 with TSIG, wildcards included; issued certificates are written to
  `ACME_CERT_DIR` on every instance.
- Streamed backups that include the blob store, and `backup:restore` into an empty database; streaming blob stores
  with S3 multipart uploads for large import bundles.
- `PLATFORM_BUNDLE_REQUIRE_CHECKS` makes the bundle scan and staging steps mandatory; signer keys are under dual
  control.
- Media and images served with `Content-Security-Policy: sandbox`, optionally from a separate `MEDIA_ORIGIN`.
- Clock skew against NTP on the platform status; zones enforced when MCP servers and connections are registered.
- MySQL data connections, read-only, and OpenBao dynamic database credentials.

### Accessibility
- The accessibility mode is stored per user and follows them to another browser.
- `UI.tabs` implements the full ARIA tabs pattern with arrow keys, Home and End.
- Move buttons for workflow steps and Up and Down buttons for classifier levels (WCAG 2.5.7).
- The Chat title is an `h1`.

### Testing
- 411 unit and API tests (1 skipped) across 31 files, with new suites `account.test.ts`, `sprint12.test.ts`,
  `sprint13.test.ts`, `sprint14.test.ts`, `sprint15-access.test.ts` and `sprint15-ops.test.ts`, and fakes for mail and
  the HIBP range API, webhook receivers, Stripe, OpenBao transit and DNS.
- `integration/operations.test.ts`: shared limits across two instances on Redis, and streamed backups restored into
  PostgreSQL and MySQL.
- The test harness serves each app on 127.0.0.1 before SuperTest sees it (`test/loopback.ts`,
  `test/setup-loopback.ts`), which fixes a port-shadowing flake on macOS.

### Upgrade notes
- Migrations `013_account` to `017_ops` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- Chat answers now stream a sentence at a time when `model-output` rules apply (the platform baseline has them), because
  each sentence is screened before it is sent.
- `POST /platform/signers` answers `202` with a proposal once any signer key exists (the first key is still added at
  once, `201`), and revoking a key answers `202`; a second platform admin approves.
- New permissions `webhooks:manage`, `prompts:manage`, `billing:read` and `billing:manage`. Tenant admins get the first
  three, knowledge curators get `prompts:manage`, and system admins hold all of them.
- New settings, all optional with safe defaults: breached passwords (`BREACHED_*`), step-up and password links
  (`STEPUP_WINDOW_SECONDS`, `PASSWORD_RESET_*`, `PASSWORD_INVITE_HOURS`), chat streams and retention
  (`CHAT_STREAM_LEASE_SECONDS`, `CHAT_RETENTION_SWEEP_MINUTES`), `/v1` (`OPENAI_STREAM_MODE`), webhooks (`WEBHOOK_*`),
  billing (`BILLING_*`, `STRIPE_*`), DPoP (`DPOP_PROOF_MAX_AGE_SECONDS`), key re-wrap (`DATA_KEY_PREVIOUS`,
  `KMS_PREVIOUS_PROVIDER`), bundles and backups (`PLATFORM_BUNDLE_REQUIRE_CHECKS`, `PLATFORM_BACKUP_BLOBS`), ACME
  (`ACME_CHALLENGE`, `ACME_DNS_*`, `ACME_CERT_DIR`), media (`MEDIA_ORIGIN`, `MEDIA_URL_TTL_SECONDS`), NTP (`NTP_SERVER`,
  `NTP_TIMEOUT_MS`) and OpenBao database credentials (`OPENBAO_DATABASE_MOUNT`). See [docs/deploy.md](docs/deploy.md).
- New CLI commands: `kms:rewrap` and `backup:restore`.
- Backups now include the blob store by default (`PLATFORM_BACKUP_BLOBS=true`), so they are larger; set it to `false`
  to keep database-only backups.

## Pre-1.0 review fixes

Fixes from the pre-1.0 codebase review, made after `1.0.0-rc.1` and included in 1.1.0.

### Security
- Secret references (`env:`, `file:`) in user stores and upstream IdPs are confined by the operator: `env:` names must
  be on `SECRET_REF_ENV`, `file:` paths inside `SECRET_REF_DIRS`, and the server's own settings and secret files are
  never readable. **Upgrade note:** list the variables your identity YAML references in `SECRET_REF_ENV` (the dev
  Compose file sets `DEV_*`); `file:/run/secrets/...` references keep working.
- LDAP and SQL user stores must be internal hosts unless `IDENTITY_ALLOWED_HOSTS` names them; a SQLite store cannot be
  the application's database. Data connections get the same confinement (`CONNECTIONS_ALLOWED_HOSTS`); PostgreSQL and
  LDAP dial the checked address and OpenSearch never follows redirects.
- A chat stream can only be resumed through the conversation it belongs to.
- Sign-in, "Test a login" and second-factor attempts reserve their place in the lockout count before the credential is
  checked, so parallel requests cannot exceed it.
- Ending someone's session (Users, Sessions, Federation) or OAuth grant needs roles that could grant theirs.
- Tool results pass the `context` guardrail checkpoint before the model sees them.
- A message cannot raise a conversation above its workspace's ceiling.
- Scheduled training jobs run with their owner's current roles and are skipped when the owner is disabled, gone or no
  longer allowed to submit.
- Authorisation denials are capped per principal (20 a minute in full, then one summary event).
- CI actions, kubeconform and base images are pinned by SHA, checksum and digest.

### Reliability
- One instance with unreadable mTLS files no longer stops gateway polling for every instance.
- Bootstrap no longer fails at start when a workspace the identity file declares has been archived.
- A response that fails after it started streaming is closed at once instead of waiting for the request timeout.
- Data-key rotation reaches every instance (a bus event, and the active key is re-read at least every five minutes).
- A throwing event-bus listener no longer breaks the publisher or other listeners.
- The gateway queue no longer adds an abort listener per wait round.
- The Compare screen detaches its socket listeners and timers when you leave it.

### Other
- Audit and usage exports are written and downloaded in sealed parts instead of in memory.
- User creation is one transaction; tenant-wide session revocation lives in `SessionService`.
- The Users and Tenants lists no longer query per row.
- The CI parse check covers `web/js/federation.js`.
- New Playwright specs for refusal states (a user store referencing a server secret, a connection to a public host).

## 1.0.0-rc.1

The first release candidate: every screen of the design prototype backed by the server. Sprint details are in
[Sprints.md](Sprints.md); the open items are the known gaps in [docs/security.md](docs/security.md), the follow-ups in
[docs/asvs.md](docs/asvs.md) and the gaps in [docs/accessibility.md](docs/accessibility.md).

### Sprint 10: hardening
- Helm chart (`deploy/helm/exprsn-ai`) with a hardened Deployment, migrations as an init container or hook Job,
  secrets from existing Kubernetes Secrets, and default-deny NetworkPolicies mirroring the zones.
- CI: npm audit, CycloneDX SBOMs of the workspace and the image, a Trivy image scan, Helm lint and render, the
  streaming load test and the Playwright console suite; Dependabot. The runtime image no longer ships npm, yarn or
  corepack.
- The OWASP ASVS 4.0.3 level 2 assessment (`docs/asvs.md`) and its fixes: `no-store` on every API answer, no internal
  errors on public pages, rate limits on the public sign-in endpoints, redaction of codes and tokens in request logs, a
  local-account password policy, protection of an admin's last second factor, the old session ended on a new
  password sign-in, and link-local hosts refused for git sources.
- Accessibility: Standard (AA) and Enhanced (AAA) modes, landmarks and skip link, labelled fields, accessible dialogs,
  popovers, toasts and command palette, focus management.
- Streaming load test (`server/loadtest/stream.ts`, `docs/loadtest.md`) and runbooks for backup and restore, incident
  response and upgrades (`docs/runbooks/`).
- Fixes: the Connections screen no longer fails to render when no connection is registered; "Test a login" counts
  directly granted roles; page loads no longer count against the sign-in rate limit.

### Sprint 9: training, zones, platform, federation
- Training: datasets with PII scrub, approval by a second ML admin for confidential data, training windows, a
  fair-share queue, checkpoints and resume, evals per hardware class, GGUF conversion to a draft model.
- Zones: versioned zone definitions with dual control, ceilings enforced by the gateway, rendered NetworkPolicy,
  Compose and nftables, endpoint health.
- Platform: signed import bundles verified in seven steps, mirrors, ACME certificates, data key rotation, backups and
  restore drills (`backup:create`, `backup:restore-drill`).
- Identity: OIDC provider (ES256 JWKS with rotation, clients, PKCE, refresh rotation, device flow, token exchange),
  SAML IdP, upstream OIDC and SAML user stores, Kerberos SPNEGO; OAuth access tokens accepted by the API.

### Sprints 0 to 8
Foundations, identity and access, tenancy and audit, the Ollama gateway, chat and compare, guardrails, knowledge,
memory and connections, the registry, MCP servers, agent runs and scripts, workflows, media and images. See
[Sprints.md](Sprints.md).
