# Security model

This page lists the controls in place as of Sprint 4 and what later sprints add. Report vulnerabilities privately to
the maintainers rather than in issues.

## Authentication

- Passwords are verified by the user store that owns the account; the application stores passwords only for local
  accounts (argon2id, OWASP parameters). SQL stores must hold argon2 or bcrypt hashes.
- LDAP: LDAPS or StartTLS with certificate verification (TLS 1.2+, optional private CA). Empty passwords are refused
  before any bind (they would be an unauthenticated bind). Filter values are escaped per RFC 4515.
- SQL stores: identifiers from configuration are validated as plain names and quoted; values are bound parameters.
- One password is never tried against a second store (see [identity.md](identity.md#chain-rules)); response time
  does not reveal whether an account exists.
- Lockout per account and per client address, shared across instances through the database; a tenant's sign-in
  policy (1.9.0) may tighten it within the platform's bounds.
- Second factors: TOTP with single use per time step and sealed seeds; WebAuthn passkeys with signature counters;
  recovery codes stored as HMACs. Admin roles require a verified factor for every admin request.

## Sessions and requests

- The browser holds only an opaque 256-bit token in a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`).
  The database stores its HMAC, keyed with the vault's platform key `session` (1.7.0; version 1 is `SESSION_SECRET`).
  Idle and absolute timeouts; the token is rotated when a second factor completes.
- State-changing requests need the session's CSRF token (HMAC-bound to the session) and, when present, a matching
  `Origin`. Socket.io connections are accepted only from the configured origin with a fully signed-in session.
- Revoking a session or disabling a user takes effect on the next request and closes live sockets.
- API keys are HMAC'd at rest, shown once, and never widen their owner's permissions.
- Helmet headers: strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), HSTS behind HTTPS,
  `no-referrer`, `nosniff`. JSON bodies are capped at 256 KB. Rate limits per user and per address, and per address
  on the public sign-in, SAML, device and Kerberos endpoints; shared across instances through one atomic Redis script
  when `REDIS_URL` is set. 20 failed bearer credentials a minute from one address get 429 for every bearer request
  from it until the window ends.
- Every API answer is `Cache-Control: no-store`. Request logs redact authorization codes, state, PKCE verifiers,
  device codes, SAML messages and tokens from URLs, and the CSRF header. `/readyz` names a failing dependency
  without its error detail.
- Signing in again with a password ends the session the browser already held.
- The OWASP ASVS 4.0.3 level 2 assessment, with evidence and follow-ups, is in [asvs.md](asvs.md).

## Authorisation

- One evaluator for every request: role → credential scopes → tenant → clearance → zone. Denials name the failing
  step and are audited: the first 20 per principal per minute in full, then one `authz.denied.suppressed` event with
  the count per route, so a caller cannot flood the chain.
- Sign-in, "Test a login" and second-factor attempts are counted before the credential is checked (an atomic
  reservation), so parallel guesses cannot get past the lockout.
- Tenant isolation: every repository method takes the tenant id from the principal; nothing reads a tenant from the
  request body.
- Grant rules prevent privilege escalation: only a system admin can grant system admin, roles can be granted only by
  the roles listed for them, clearance cannot be granted above the granter's own, and admins cannot change their own
  access.
- Custom roles (1.5.0, B-3302) are built only from catalogue permissions and never hold a permission their creator, or
  for a pending version its approver, does not hold; a custom role is granted only by holders of its `grantableBy`
  roles who also hold every permission it carries, and it resolves only inside its own tenant. A role holding an admin
  permission (outside the member baseline) changes only when a second holder of `roles:manage` approves the version,
  and `requiresMfa` cannot be lower than the built-in roles granting the same permissions require. The zone ceiling and
  clearance steps still apply to everything a custom role grants.
- Every route declares what it requires in one table (`server/src/authz/routes.ts`, B-3304); the test suite fails
  for a route that is not declared or whose middleware disagrees with its entry. Access reviews (B-3305) remove a
  revoked grant at once, and the member's sockets leave the permission rooms it gave.

## Audit

Per-tenant SHA-256 hash chain over canonical JSON (every field, including the previous hash). Rows are never updated
or deleted by the application; verification is read-only. Events above the reader's clearance are returned without
content.

- **Signed checkpoints:** hourly (and on demand) the head of each chain is HMAC-signed by the KMS, with a key the
  database never holds, and a copy is written to the blob store. Verification recomputes the chain and checks every
  checkpoint, so history rewritten consistently (every hash recomputed) still fails at the first checkpoint after
  the change. A failed verification notifies tenant admins and auditors in the console and by email.
- **Corrections** are new rows that reference the row they correct; the original stays.
- **Exports** never contain rows above the requester's clearance: a selection that would is refused with the count,
  and the filtered export records how many rows it left out. Export files are written and sealed with the tenant key
  in parts of about 1 MiB (each bound to its position), and downloads stream them, so neither holds the file in
  memory; downloads are audited.
- **SIEM:** every event is streamed as it is appended (NDJSON over HTTPS, bearer token).

## Secrets

Configuration holds references (`env:`, `file:`), never values. The server reads secret files at use time. Container
and systemd deployments pass secrets as files (Docker secrets, systemd credentials), not environment variables.

References are written by tenant admins (user stores, upstream IdPs), so what they can reach is the operator's
choice: `env:` names must be on `SECRET_REF_ENV`, `file:` paths must resolve inside `SECRET_REF_DIRS`, and the
server's own settings and secret files are never readable. Without this, an LDAP store pointed at a host the admin
controls would receive `DATA_KEY` as its bind password, and a SQL store on `DATABASE_URL` would turn "Test a login"
into a password oracle for every tenant. LDAP and SQL store hosts, data connections, MCP servers, workflow HTTP steps,
mirrors and upstream IdPs are all confined to internal addresses (plus their allow-lists), never link-local.

### Deployed VMs and containers (1.9.99-final, Sprint 58, B-10204, B-10205)

- A cloud VM installs only a release tarball whose sha256 matches the pinned digest (and whose cosign bundle verifies,
  when one is pinned); the check runs in the user data's bootstrap and again in `install.sh --from-release`, before
  anything from the archive is extracted or run. A refusal is an `exprsn-install: refused ...` console line, and the
  `vm.install` readiness check fails verify on it.
- EC2 instances require IMDSv2 with a hop limit of 1, so a container or a forwarded request on the VM cannot read the
  instance's metadata or role credentials; an update puts the options back when they drift. App VMs have no public
  address.
- The user data holds no secret value: secrets reach a VM once, in a single-use OpenBao response-wrapping token (15
  minutes) the adapter writes into the user data at create time, and become systemd credentials (sealed to the host
  with `systemd-creds` where it works). Anyone who can read the instance's user data after first boot finds a used
  token; one who unwraps it first makes the install refuse, which shows.
- Container platforms never carry `DATA_KEY` (or `DATA_KEY_PREVIOUS`, `SIGNER_TOKEN`, the cloud credentials) as a
  variable: Container Apps mounts secrets as files; ECS and App Platform get the other secrets from their secret
  stores and the key-encryption key stays in OpenBao transit (open decision 8). `computeProblems` blocks a plan that
  breaks this, and apply checks it again. Secret values go only to the provider's secret store, never into the graph,
  the journal or an error.

## Encryption at rest

Envelope encryption with a data key per tenant (and one for platform secrets such as TOTP seeds). Data keys are
random AES-256 keys stored only wrapped by a key-encryption key in the KMS: OpenBao/Vault transit, AWS KMS or Azure
Key Vault (1.9.99-final, below), or locally a key derived from `DATA_KEY`. Conversation titles, message content, thinking and calculation steps, attachments and export
files are sealed with AES-256-GCM under the tenant's data key, with the row's identity as associated data, so a
ciphertext moved to another row or tenant does not open. Keys rotate by version (`exprsn-ai kms:rotate`); old
versions stay readable. Offboarding destroys every version of the tenant's key, in OpenBao too, and every instance
drops its cached copies at once, so the tenant's sealed data is unreadable before the purge job deletes it.

## Model serving

- Only the gateway talks to Ollama, over internal networks, optionally with mutual TLS per instance.
- Models enter through an import request: pickle checkpoints are refused, the pulled blob's digest must match the
  digest pinned in the request (the blob is deleted otherwise), and only GGUF and safetensors formats are accepted.
- Approval is dual control (not the requester), needs a recorded licence and a passing conformance run; a model
  that fails the tool-calling test has its tools capability withheld.
- A model's catalogue entry records how it thinks (B-11707): natively, by a template, or not. A template model's
  reasoning is separated from the answer in the gateway, before any caller sees the stream, so it is screened, checked,
  sealed and shown as thinking exactly as native thinking is, and the template's tags are never stored or shown as
  answer text. What a template model writes outside its tags is answer text: a model that ignores its template (the
  conformance run's "Thinking template" test shows it) puts its reasoning in the answer, where the answer's checks
  apply. Changing a model's thinking mode needs `models:manage`, is audited as `model.updated`, and does not need a
  second approver although it changes the system prompt of every profile on the model that asks for thinking.
- A profile carries a label: users need that clearance to pick it, and a conversation labelled above it cannot use
  it (the zone step of the policy). Pools carry a label ceiling, and requests are only routed to pools cleared for
  the conversation's label.
- Chat attachments are quarantined, type-checked from their bytes, scanned with ClamAV when configured, and
  classified for payment cards, IBANs, national identifiers, emails and phone numbers before a chat can use them;
  a file classified above its owner's clearance or the workspace ceiling is rejected.
- Model output is rendered as text in the console, never as HTML.
- Since 1.6.0 (B-43) an instance may be a Chat Completions server (`kind: openai`: Apple's `fm serve`,
  `mlx_lm.server`, `llama-server`) on a URL, under the same egress check and mutual TLS, or on a Unix socket on the
  server's host. Its bearer token is a vault secret read as the administrator who saved it. Its models are registered
  from its `/v1/models` listing with `format: server` and no digest; the licence, the conformance run, the label
  ceiling and dual-control approval apply as to a pulled model.

## Images in Knowledge (1.6.0, Sprint 36c)

- **Before any model sees an image.** An image upload (PNG, JPEG, WebP, GIF, HEIC) goes through the same sealed
  quarantine as other uploads: its type is sniffed from the bytes and ClamAV scans it when configured. Indexing then
  runs the image safety check (`IMAGE_SAFETY_URL`, `IMAGE_SAFETY_THRESHOLD`); with `IMAGE_SAFETY_REQUIRED` an image no
  classifier checked is refused as well. A flagged image is `rejected`: its stored content is deleted, nothing of it
  reaches an index, and the system audit entry `knowledge.image.withheld` records the score, classifier and
  categories. Images taken out of a PDF or Word document (its parts) are documents of their own and pass quarantine
  and the safety check themselves.
- **What a caption or OCR text may leak.** The vision profile writes text about anything visible in the image: names,
  account and card numbers, addresses, people described, a screenshot of a password or an API key. That text is sealed
  at rest with the document (associated data `kdoc-vision:<id>`), then chunked, embedded and indexed like any document
  text. The PII classifier runs over it and can raise the document's label (an IBAN read from a screenshot makes the
  image confidential), and the `context` checkpoint screens both the chunk and an image hit's caption and text excerpt
  (withheld by a blocking rule, rewritten by a redacting one). The image itself is sent to the vision profile's pool at
  the label known before it is described: the base's label, the source floor, the parent document's label and a
  manual label. A label the OCR text raises afterwards does not change which pool already saw the image, so a base's
  label must reflect what its images may show. The vision profile must route to a model that reads images and both
  must be cleared for the base's label; this is checked when the profile is set.
- **Labels are metadata at the image's label.** Each label a vision classifier gives an image (`knowledge_doc_labels`)
  carries the image's own label rank and follows a relabel. The label filters on search and on the documents list,
  and the label counts behind the filter chips, read only labels of documents within the caller's clearance (the
  documents list and search also apply row access), so a label name or a count never reveals an image above the
  reader. Vision classifiers publish only after an evaluation with at least 200 image cases per label, and only
  published ones label documents.
- **Thumbnails.** The thumbnail URL serves the image itself, only after the safety check passed and the document was
  indexed, to readers cleared for its label and allowed by its row access, with `X-Content-Type-Options: nosniff`, a
  `default-src 'none'; sandbox` content security policy and `Cache-Control: private, no-store`. HEIC images have none.
- **Parts of PDF and Word documents** take the document's label as a floor (a part cannot be relabelled below it, and
  a relabel of the document raises its parts) and its row access; removing the document removes them.
- **Eval image cases** are sealed in the blob store (`eval-images/<tenant>/<case id>`, associated data
  `eval-image:<case id>`) and deleted with the tenant at offboarding.
- **`knowledge_search`**, the built-in tool agents and workflows search with, searches only published bases shared
  with the caller, at most at the label of the conversation or run it is called from (and never above the caller's
  clearance), so a result never carries data above the context it lands in.
- **The research built-ins** (`knowledge_list`, `knowledge_read`, `memory_search`; `knowledge_save`, `memory_save`)
  follow the same rule: reads are made with the caller's clearance lowered to the label of the call, a document or
  memory saved from a call is at that label, and a base labelled below the call refuses the save. They act through
  the knowledge and memory services as the caller (sharing, row access, the `context` and `memory` checkpoints, the
  upload scan, the curator's decision on workspace memories, the credential ban), and the two writes need approval.

## HTTP tools and untrusted content (1.6.0, Sprint 37a)

- **HTTP tools (B-89) reach only what an operator and a tenant admin allow.** Ported from exprsn-platform under the
  port findings' constraints (decision D11c). The scheme and host of an `impl: http` tool are fixed by its author; only
  the path and query take the model's arguments, percent-encoded. Every call goes through the outbound address guard
  (`platform/egress.ts`, `guardedRequest`): the host is resolved once, every address is checked, the connection is
  pinned to the checked address (a second DNS answer cannot point elsewhere) and redirects are not followed. Cloud
  metadata addresses (169.254.169.254 and the other providers'), unspecified, multicast and broadcast addresses are
  always refused, also when written as a literal at save time; link-local, private and loopback addresses only when
  `SERVICE_ALLOWED_HOSTS` names the host or network; public addresses only when the tenant's list of allowed hosts
  names them (kept by `tenant:manage` on the Registry screen and audited `tenant.hosts.updated`). A tenant's list never
  admits an internal host. Answers are capped (`HTTP_TOOL_MAX_RESPONSE_BYTES`) and timed out (`HTTP_TOOL_TIMEOUT_MS`).
- **Credentials only as vault references.** `Authorization`, `Proxy-Authorization`, `Cookie` and any header, query
  parameter or body field named like a credential take `vault:path#key`, refused as a literal when the tool is saved
  (and the secrets scan check runs over the whole definition). The references are resolved on every call as the tool's
  author, under the vault policies and the author's `secrets:read` (a reference the author cannot read is refused at
  save), and the value is placed in the request only. The audit entry `registry.http.called` and the meter
  (`registry_http_calls`) keep the host, method, status, size, latency and outcome; never the path, query string,
  headers or body. An HTTP tool goes through the registry's review and publish lifecycle; GET tools are `read`, every
  other method `write` or `destructive`, so chat and `/v1` never offer a write HTTP tool and agents and workflows hold
  it for approval. Arguments pass the `tool-call` guardrail before the request; the tool's rate limit applies.
- **Untrusted content is marked (B-6901).** Retrieved knowledge chunks, crawled pages, tool results, MCP results and
  HTTP tool answers reach the model inside `<untrusted-content>` delimiters that name the source and say the text is
  data, with its words joined by a datamark (Spotlighting), and closing tags inside defused. Per profile
  (`trust_marking`), on by default. A delegated agent's answer and a workflow's output are not wrapped again (their own
  inputs were screened and marked inside their runs). Marking lowers the chance a model follows an instruction it
  reads; it does not make it impossible.
- **The untrusted-content checkpoint (B-6902)** screens each such text before the model reads it. The platform
  baseline's `injection-untrusted` rule (heuristic classifier, threshold 0.6) annotates: the text goes in with a
  warning. A tenant, workspace or agent rule set adds a blocking rule to leave chunks out and withhold tool results.
  The `injection` mechanism's guard-model engine asks a profile's model instead and fails closed by default. Each
  detection is counted per source without its text (`injection_detections`, 90 days) and audited
  `guardrail.injection.detected`; the inspected text is in the sealed guard decision like any checkpoint's.
- **The corpus (B-6903).** CI fails when the heuristic classifier, the checkpoint with the baseline rule, or a
  guard-model rule detects fewer than 90% of the corpus's attacks or flags more than 10% of its benign texts.
## The MCP server and MCP authorization (1.6.0, Sprint 37b)

- **Per-user access without a service account (B-7101).** Before 1.6.0 Exprsn-AI was an MCP client only, so reaching
  its workflows or records from an MCP client meant a separate MCP service holding a service account's credential,
  which acted with that account's rights for everyone. Each workspace's MCP server now acts as the person who signed
  in: their roles narrowed by the token's scopes, their clearance lowered to the label the workspace publishes at, the
  workspace membership, and the same dispatcher, label ceilings, rate limits and `tool-call` and `context` checkpoints
  as a call from the console. Nothing is published until an identity admin turns a workspace's server on, and only the
  groups chosen there.
- **Writes wait for the person (B-7101).** A write or destructive call, and any call the `tool-call` guardrail holds,
  does not run: it is held with its arguments sealed (`mcp-hold:<id>`) and the person is notified. Only a browser
  session decides (the decide route is session-only, and an MCP token is refused by the API anyway), so a client, or a
  prompt injected into its model, cannot approve its own call. An approval covers that tool with exactly those
  arguments (compared by hash), once, for 15 minutes; a pending call lapses after an hour.
- **A resource server of the tenant's issuer (B-7102).** The endpoint accepts only access tokens from the tenant's own
  issuer whose audience is that endpoint's URL (RFC 8707): the resource named at the authorization endpoint is checked
  against the tenant's endpoints, kept with the code and the refresh token family, and becomes the `aud`. A token for
  the API, another workspace or another tenant is refused with `401` and the protected resource metadata URL (RFC
  9728); the API refuses tokens for an MCP endpoint, so a token handed to an MCP client cannot be replayed against the
  console's API. Revocation, disabled clients and users, ended sessions and the deny-list apply as to any token from
  the issuer. DPoP-bound tokens are checked with a proof per request and can be required per workspace. Requests with
  a foreign `Origin` are refused (DNS rebinding), failed tokens count towards the per-address bearer-failure limit,
  and each user has at most 600 requests a minute.
- **Dynamic client registration is off by default (B-7102).** When an identity admin turns it on, any client that
  reaches the issuer can register (RFC 7591), but only with the authorization code grant, PKCE required, redirect URIs
  on HTTPS or a loopback address, and the MCP scopes; each such client is third-party or public, so every person is
  asked for consent before it acts as them, and an admin can disable it like any client. At most 500 per tenant.
- **OAuth for the MCP client (B-7103).** Each person connects to an authorization-protected MCP server with the
  authorization code grant and PKCE (`S256`), naming the server as the resource. The `state` is single use and bound to
  the browser that started the flow by an HttpOnly cookie (so a code obtained by someone else cannot be attached to
  another account), the verifier is sealed at rest, and an `iss` in the answer must be the authorization server asked
  (RFC 9207). Access and refresh tokens are sealed with the tenant key (`mcp-token:` and `mcp-refresh:` associated
  data), refreshed before they expire, deleted when a refresh is refused, and revoked at the authorization server when
  the person disconnects. Metadata, registration, token and revocation requests use the internal-hosts dispatcher of
  MCP calls; tokens never enter model context.

## The AI inventory, analytics and audit export (1.6.0, Sprint 38a)

- **The inventory is a register, not a new authority.** It reads the objects it lists through the same tables their
  own screens use and adds owner, oversight role, provenance, lineage note, known issues and impact assessment per
  system (`inventory_systems`), under `models:manage`. The only enforcement it adds is the publish gate: with the
  tenant's `requireOwner` setting on, the registry refuses to approve an agent that has no owner (`409`), on top of
  the registry's own dual control. The gate is off by default so existing tenants keep publishing until their
  register is filled in; turning it on is audited. Known issues are counted from open flags raised in the system's
  agent or workflow runs and from failed evaluations; nothing is inferred from message text.
- **Analytics reads the meter, never the content.** Every figure is a sum over `usage_records` (the rows the quotas
  count), grouped by workspace, group, model, profile or user; `by=tenant` is for system admins. The group dimension
  follows group membership, so a user's records count once per group they are in. Costs are computed at read time
  from the tenant's prices and withheld for a row that mixes priced and unpriced records, so a partial figure never
  reads as a total. Prices are `tenant:manage`, one currency per tenant, audited. The chargeback export is the same
  computation and is audited with its total.
- **Tracing carries token counts only.** `gen_ai.usage.*`, `gen_ai.response.model` and `gen_ai.provider.name` join
  the allow-listed span attributes; the prompt and the answer still never leave the server.
- **JSONL exports keep the chain verifiable.** A window holds every event between its bounds, those above the
  requester's clearance redacted to their hashes (the hash covers all fields, so a redacted row cannot be recomputed,
  but its `prev_hash` and `hash` still link the chain), and ends with a checkpoint signed by the KMS at the window's
  last sequence (`AuditCheckpoints.createAt`, the same HMAC key as the scheduled checkpoints). `audit:verify-export`
  needs nothing but the file; the HMAC is verified online by `audit:verify`. Requests and downloads are on the chain.
- **Streaming per tenant is dual-controlled and guarded.** A destination is proposed by one tenant admin and approved
  by another (the proposer cannot approve what they proposed); until then nothing is sent. Bearer tokens are sealed
  with the tenant key and never shown again; a private CA is kept for the TLS connection. Every delivery dials
  through the outbound address guard: HTTPS through the policy-checked dispatcher (no redirects), syslog through a
  policy-checked lookup, so a destination whose name later resolves to a refused address stops working at that call.
  Cloud metadata addresses are refused at save. Events are filtered per tenant before they reach a forwarder; the
  platform stream (`SIEM_URL`) stays the operator's. Delivery is at least once with backoff; overflow is counted as
  dropped on the row, and the chain in the database stays the record of truth.

## Row and field policies, DLP, legal holds and compliance exports (1.6.0, Sprint 38c)

- **Policies narrow, never widen (B-8101, B-8102).** A policy is applied after labels and workspace membership: a
  reader reaches a record only when it is at a label they clear, in an app of their workspaces, and (once the entity
  has a policy) in the rows a policy that names them allows. The row condition is run by the same query builder as any
  filter, over the clear index, so a policy can only name indexed or unique fields (checked when it is saved, for
  every entity it covers); a placeholder the reader has no value for makes the policy grant nothing, never everything.
  A reader without `read` on a field cannot filter or sort by it (no inference from an ordering), and the field is not
  in the record at all; a reader without `unmasked` gets the mask from the server (the full value never leaves it,
  exports included). Grants combine permissively across the policies that name a reader, so a tenant that wants a
  narrow result keeps its policies narrow. Designers (`apps:design`) are exempt: they define policies and can read the
  records through the bundle export anyway; explain shows them what every reader gets. The user attributes policies
  compare are set only by `users:manage` and audited with the user update.
- **DLP acts after the guardrails, with no shadow stage (B-7601).** DLP rules are the tenant's data classification,
  always in force for the scopes they name, kept by `compliance:manage` and audited. The built-in detectors are the
  checksummed ones of the PII and secrets classifiers (scores below 0.8 are ignored); tenant patterns are compiled
  with RE2 (linear time, no backtracking). A hold goes where a guardrail hold goes: the flag queue, where a reviewer
  cleared for the label decides; an agent run ends failed with the rule's name; an upload is rejected with it. A
  raised label is written to the message, the conversation (a high-water mark, never lowered), the run, the
  attachment or the file version, and content raised above its owner's clearance is held regardless of the rule, so a
  rule that only labels cannot show someone what they may not read. The DLP test endpoint stores and audits nothing.
- **Legal holds are dual-controlled and quiet (B-7602).** A hold is asked for by one holder of `compliance:manage`
  and approved by another (self-approval is refused), the reason is sealed with the tenant key (the audit chain keeps
  a 500-character excerpt), and the people concerned are not told. An active hold is read by the chat, memory and file
  purges on every run; releasing it is audited and takes effect at the next purge, nothing is deleted at once.
- **Compliance exports are clearance-bound and sealed (B-7603).** The job reads the requester's clearance when it
  runs and leaves out every row above it, counting what it left out; the export carries the highest label it holds and
  is downloaded only by someone cleared for it. Parts are sealed with the tenant key (per-part AAD) in the blob store;
  a download streams them part by part and is audited with the counts. An API key scoped to `compliance:export` (the
  eDiscovery token) can do no more than its owner and is named in the audit events and the export row.

## Content credentials and chat artifacts (1.6.0, Sprint 39a)

- **Two manifests, two keys (B-7901).** The HMAC manifest of Sprint 20 proves to this server that it made the image;
  it proves nothing to anyone else. The C2PA manifest is signed by a certificate the tenant's own issuing CA made, so
  a verifier outside the server (or `exprsn-ai c2pa:verify` on a downloaded file) can check the claim's signature,
  chain it to the tenant CA and bind it to the bytes without trusting the server. The certificate's key is in custody
  (signer process or OpenBao) like every CA key; the app signs claim bytes through the same path it signs
  certificates and never holds the key. Revoking the certificate on the Certificates screen retires it: the next
  image signs with a new one, and the old manifests still verify against the chain but a validator that checks
  revocation (CRL, OCSP, both published by the CA) will say so.
- **The manifest is part of the file.** It covers every byte outside its own chunk, so a changed pixel fails
  `dataHash`; a changed claim fails `signature`; a stripped chunk is `present: false`. It is added last, over the
  HMAC chunk, and the HMAC manifest is verified over the bytes without either chunk, so both verify on one file.
  Nothing in the manifest is secret: the prompt is a hash, the user an id and username, and the label is stated.
- **What a conformance validator may dispute.** The implementation is the specification's parts written here (CBOR,
  JUMBF, COSE_Sign1), not a reference library: there is no RFC 3161 time stamp (the signing time is the action's
  `when`, and validity is judged at verification time), no `c2pa.ingredient` chain for a variation of another image,
  and the hashed-URI hash is the SHA-256 of the assertion's content box with its header. `verify` checks what it
  writes; a third-party validator that reads the structure will see a manifest whose signature verifies but may flag
  those points.
- **Artifacts are the answer's own text (B-8001).** An artifact is a sealed copy of a fenced block of an answer, with
  the answer's label and message id; a share reader sees only versions from the messages on the shared path, never
  from another branch or a withheld or held answer, and nothing above their clearance. Nothing in an artifact is
  checked again by the guardrails: it was screened as part of the answer.
- **Rendering untrusted HTML.** A model's HTML runs in an `<iframe sandbox="allow-scripts">` whose document comes from
  `/api/public/artifacts/:vid/raw` with its own CSP: `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`,
  `frame-ancestors 'self'`, and the `sandbox` directive without `allow-same-origin`. The document is an opaque origin:
  it cannot read the console's cookies, storage or DOM, cannot call the API with the reader's session, cannot
  navigate the page that frames it, and cannot submit a form or open a connection. The URL is a capability (the
  version id, an expiry and an HMAC by the KMS) valid for `CHAT_ARTIFACT_RAW_TTL_SECONDS`, minted only when a reader
  who may see the artifact lists it; the route reads no session, so a stolen link shows that one version for a few
  minutes and nothing else.

## App packages, environments and promotion (1.6.0, Sprint 39b)

- **A package is verified before it is read (B-8201).** As with bundles, the signature (the KMS HMAC key the server
  holds) is checked over the canonical JSON of exactly what arrived, before the shape or any object in it is looked
  at; a package changed in any byte, signed elsewhere, naming another key or unsigned is refused with `422` and the
  refusal audited, and nothing is created. A package pasted in, read from a repository or deployed from the store is
  verified the same way, and a stored package is checked against its hash when opened. Records in a package are the
  values the packager was cleared for, without computed fields (recomputed on import); a package is sealed with the
  tenant key at rest and capped at `APPS_PACKAGE_MAX_BYTES`.
- **Applying a package reconciles, it does not replace (B-8201, B-8203).** Entities, forms, triggers and policies are
  matched by name, so a deployment keeps record ids and the entity revisions move forward; the same type and unique
  checks apply as to a designer's edit (a type change on an entity that holds records fails the deployment, and the
  target keeps what it had, with the backup beside it). An entity the package no longer has is dropped only when it
  holds no record; otherwise it stays and the report says so. Triggers are recreated against the workflows of the
  target's workspace by name, so a trigger whose workflow is missing or unpublished there is skipped and reported,
  never pointed at another workspace's workflow.
- **Production waits on the Workflows approval step (B-8202).** A promotion to production lands only the package the
  last successful promotion to test landed (its id and hash are on both deployments), never a fresh package of the
  test or development app, and only after a run of the pipeline's approval workflow succeeds. That run starts as the
  requester, with the deployment as its input and caller, so the approver sees who asked, what package and which
  hash; a rejection, a failure, a cancellation or an expiry rejects the deployment. Nothing else moves on a pipeline
  while a deployment is going. Deployments run as the requester (their roles and clearance at run time, in the
  target's workspace), so an app the requester may no longer design is not deployed.
- **Backups and rollback (B-8203).** Every deployment first packages the target as it is; a rollback is a deployment
  of that backup, with its own backup, so it is audited and reversible like any other. The history (who, what,
  which package, the report) is kept `APPS_DEPLOYMENT_HISTORY_DAYS`.
- **Git stays behind the same guards (B-8204).** Repositories are `https://` only (`file://` for same-host mirrors
  when `APPS_GIT_ALLOW_FILE` is on), never with credentials in the URL, never at a link-local, multicast or
  unspecified address (checked after DNS); git runs with no system or global configuration, no hooks, no prompts and
  only the https (and allowed file) protocol. A token is given as a vault reference, resolved as the caller at use
  and answered to git through a credential helper from the environment, so it is not on a command line or in a
  remote URL. The push writes the package's files, nothing else, under the path given, and a path that leaves the
  tree is refused.

## Data model drafts, AI fills and outside tables (1.6.0, Sprint 39c)

- **A draft is a proposal (B-8301).** The description passes the `user-input` checkpoint and the model's answer the
  `model-output` one, as any app draft does; the draft is validated with the same schema and checks as a saved
  entity, against the app's entities and each other, and nothing is written until a designer accepts it. Accepting
  never removes a field or a state: fields the draft omits are listed and kept, so a model cannot drop data; a type
  change on an entity with records is refused by the entity update as always. Triggers are created only for workflows
  the designer may already see, and only `record` triggers: a draft cannot name a schedule.
- **AI prompts read fields through the formula engine (B-8401).** A placeholder is a field name or a formula over the
  entity's plain fields and the formula functions, compiled by the same parser that refuses everything but fields and
  listed functions, so a prompt can no more reach a global than a formula field can; an unreadable placeholder is
  refused when the entity is saved and renders empty if one slips through. Only the fields whose prompts read a changed
  value regenerate, and a burst of edits asks the model once per field (`APPS_AI_DEBOUNCE_MS`), which bounds what one
  editor can spend; the fill still runs as the record's last editor, within their clearance and the profile's.
- **A fill over every row is one metered, cancellable job (B-8402).** It needs `apps:design`, shows its estimate first
  (and the money when the tenant priced the model), runs one record at a time through the profile's guardrails and the
  tenant's quota (the quota refuses the next record when it runs out), and stops between records when cancelled; one
  fill per field at a time. Its token totals are on the fill and in the audit events; the answers themselves are
  sealed in the records like any value.
- **An outside table is read unmasked, by designers who also manage connections (B-8501).** The connection's PII
  masking is for ad-hoc queries and knowledge; records of a sourced entity carry the rows as they are, so attaching
  one needs `connections:manage` beside `apps:design`, the table must be on the connection's allow-list, and the
  entity's label must cover the connection's: the rows land sealed under at least the label the connection carries,
  policed, labelled and audited like any record. Pulls are audited with their counts, never their values. Writes
  through to the table run only when the designer turned them on, through parameterised statements on plain column
  names (quoted identifiers, values as parameters) in their own transaction, before anything changes locally: a
  refused write leaves the app as it was. The connection's own account decides what the writes may do; a read-only
  account makes writes fail with `502` and the app untouched.

## Entity APIs and app embedding (1.6.0, Sprint 39d)

- **The entity API is the records API with another shape (B-8601).** `/api/apps/:app/:entity` calls the same service
  as the records routes: the reader's policies narrow the rows and mask the fields, labels and workspaces apply, every
  write is audited as before, and `include=related` fetches each related record through the same read path, so a
  record the reader may not read comes back as null. A key limited to one app or one entity (`api_keys.app_scope`)
  holds at most `records:read` and `records:write`, is accepted under `/api/apps` alone (never `/v1`, the MCP server or
  the rest of the API), and is refused by every apps router on another app or entity before any handler runs; the
  owner's own app-limited key leaves `apps:design` out, so it reads masked like a member. The scope is checked on
  ids, whatever the path names.
- **Every design change leaves a version (B-8602).** The Apps screen, the schema API and a package import all end in
  `AppService.createEntity`, `updateEntity`, `removeEntity` or the forms service, which record a row of
  `app_schema_versions` with the SHA-256 of the whole design afterwards, under the audit event `app.schema.versioned`;
  the version numbers are unique per app on the database. The OpenAPI document and the client are computed from the
  design on each read and carry that version and hash (the `ETag`), so a stale document cannot be served and a client
  knows the design it was built on.
- **Embed pages are framed only where the designers said (B-8701).** A public form becomes an embed page under a
  random 26-character id; the page is served with `frame-ancestors 'self' <allowed hosts>` and no `X-Frame-Options`,
  so a browser frames it on those origins and refuses it elsewhere, and `noindex`. The page opens and submits the form
  by the embed id through `/api/public/embeds`, on the public submission path (per-address and per-form limits, the
  `user-input` checkpoint, held values queued), so the form's link token never reaches a host site; turning public
  pages off, unpublishing the form or removing the page gives `404` at once.
- **A signed embed is a credential the host site vouches for (B-8702).** The host signs a short JWT with a key the
  app's designers registered: a public key (ES256, RS256, EdDSA), a shared secret (HS256, sealed with the tenant key,
  shown once), or a certificate the tenant CA issued, carried as `x5c` and verified against the tenant's active
  intermediate and its revocations. The `kid` picks the key and the `alg` must match it (no algorithm confusion); the
  audience must be the app; `exp` is required and capped by the app's and the server's limit; `jti` is required and
  accepted once per key, so a token cannot be replayed; the person is an active user named by a claim the designers
  chose. The exchange is rate-limited per address and audited either way with the kid and the reason, never the token.
  The embedded session is a bearer of its own, apart from console sessions: no cookie, so nothing cross-site and no
  CSRF surface; `/api/apps/<the app>` only, the entities the settings list, read-only unless the app allows writes;
  it ends with its key, with the app's settings turned off, or when the designers end it.

## Guardrail rules drafted from a description (1.7.0, Sprint 41)

- **The model's answer is untrusted (B-9601).** A profile's model turns a guardrail admin's description into one rule.
  Only the rule's name, checkpoint, mechanism, action, severity and description are read from the answer; the id, the
  stage (`shadow`), `onError` (`closed`) and `enabled` are set by the server. The mechanism must be a deterministic
  one (`pattern`, `pii`, `secrets`, `budget`, `allow-list`), so a draft names no profile and no classifier, and a
  pattern is compiled with RE2 like any other. The draft is validated with the rule schema and is never executed.
- **A draft only adds.** Its id is one that no rule of the set and no rule of the platform baseline has, so it cannot
  replace, relax or remove a rule. Saving takes the rule from the server's own copy of what was shown in the diff,
  not from the request, and only the person who asked for the draft can save it.
- **Enforcing needs a second person (B-9602).** A saved draft marks its rule. A version in which a marked rule
  enforces is refused by direct publish and goes through review: someone other than the draft's author and submitter
  approves it. After one such approval the rule is treated as any other. Until then it runs in shadow, which records
  findings and changes no outcome.
- **The call is the caller's.** The description passes the `user-input` checkpoint before the model reads it, the
  caller needs `inference:invoke` as well as `guardrails:manage`, the profile's label ceiling applies, and the use is
  metered and audited. The description is not written to the audit trail.

## Deployment hardening

## Red-team suites, agent identities and handoffs (1.6.0, Sprint 38b)

- **An adversarial gate beside the evaluations (B-7001).** A profile's or an agent's publish gate could require
  passing evaluations, but nothing asked whether the model gives up its system prompt, follows an injected
  instruction or reaches for an outside address. A red-team suite does, with the built-in attack categories (the
  Sprint 37a corpus cases with a canary handed over as documents, jailbreaks, exfiltration through tools,
  system-prompt extraction) and the tenant's own cases; every attack is judged deterministically (a canary, the
  attack's address in the answer or in a tool call's arguments, eight consecutive words of the system prompt), so a
  run's verdict does not depend on a judge model. A profile with a gated suite is published only once its settings
  hash has a passing run, and no evaluation override opens that gate; an agent version is approved only once its
  schema hash has one. Attacks against agents run as child runs under the agent's own budgets and approvals: a run
  that pauses on an approval is cancelled and judged on what it reached for, so a red-team run never approves a
  write.
- **Every successful attack is reviewed (B-7002).** An attack that succeeded is a flag in the review queue (checkpoint
  `red-team`, high severity for extraction and exfiltration), labelled as the suite and sealed like any excerpt; a
  reviewer confirms it into an eval case or dismisses it. The flag names the attack, the target and the run, never
  the suite's own cases beyond the one that succeeded.
- **Agents as principals (B-7701).** A run used to act with everything its owner may do. With an identity, the run
  acts within the identity's roles (as credential scopes, decided by the scope step of the policy pipeline) and the
  lower of the owner's clearance and the identity's ceiling, so an agent granted no knowledge access cannot search
  it even when an admin runs it, and a run labelled above the ceiling fails before it thinks. Audit events carry the
  agent beside the user. Keys minted for an identity authenticate as the agent on the owner's behalf within the
  identity's grants, the owner's and the key's scopes; they are refused the moment the identity is turned off, are
  narrowed when the identity's roles are, and are never listed among the owner's personal keys. An identity's roles
  never widen their author: every permission they grant, the author holds.
- **Handoffs end the run (B-7801).** A handoff reuses the delegation path (a child run in the chain, within the
  remaining budget, under the delegate's ceiling), so nothing an agent could not delegate to can be handed to; the
  handed-to run's answer becomes the run's answer and the reader sees who answered.



Container: non-root, read-only root filesystem, all capabilities dropped, `no-new-privileges`, internal networks for
the database and Ollama. systemd: `ProtectSystem=strict`, `NoNewPrivileges`, empty capability set, system-call
filter, private `/tmp`, only the state directory writable.

## App flow integrations and incoming webhooks (1.7.0, migration 082)

- **Integration actions are workflow steps.** A flow's tool, script, agent, AI, message and HTTP actions compile onto
  the `tool`, `script`, `agent`, `model` and `http` steps (`apps/flow-integrations.ts`), so the dispatcher, the
  tool-call guardrail, label ceilings, budgets, the script sandbox and the HTTP address guard apply unchanged. At save
  the flow is also checked in the designer's workspace: a write tool, a message or a writing script needs an approval
  action with no run condition before it (refused otherwise, rather than pausing at run time); tools, agents and
  profiles must be cleared for the entity's label, which every run carries; an HTTP request must name a host on the
  tenant's list of allowed hosts and keep credentials as vault references (`literalSecret`), and its host cannot come
  from a template.
- **The webhook is signed, fresh and once.** `POST /hooks/apps/<tenant>/<flow>` (no session) needs `X-Exprsn-Signature`,
  HMAC-SHA256 under the flow's secret of `<timestamp>.<raw body>`, compared in constant time, with `X-Exprsn-Timestamp`
  within 5 minutes. The timestamp is inside the signature, so a captured request cannot be re-sent with a new time;
  each accepted signature is kept in `app_flow_hook_nonces` for ten minutes, so it is refused a second time on any
  instance. Bodies over 64 KB are refused before they are read in full, 60 requests a minute per flow (shared
  counters), JSON objects only.
- **The secret** is 32 random bytes, shown once, sealed with the tenant key (`appflowhook:<flow id>` as associated
  data), never in a package or the flow view; rotation replaces it at once and forgets the signatures seen.
- **Off by default, owned, screened.** A hook takes requests only once a designer with `workflows:manage` turns it on;
  its runs start as that person, checked again on every request (active, `agents:run`, `records:read`, in the
  workflow's workspace), at the flow's label. The payload passes the `untrusted-content` (prompt injection) and
  `user-input` checkpoints before the run exists; a block or hold refuses it (`422`), a redaction carries on only
  when the redacted text is still a JSON object. An unknown flow and one that is off answer alike (`404`).
  Accepted and refused requests are audited (`app.flow.hook.received`, `app.flow.hook.refused` with the reason).

## Workflow webhooks and run retention (1.8.0, Sprint 46, migrations 085 and 086)

- **One signed hook for app flows and workflows (B-130).** `workflows/signed-hooks.ts` holds the checks both use: the
  64 KB cap, the HMAC-SHA256 of `<timestamp>.<raw body>` compared in constant time, the 5-minute window, one
  acceptance per signature through the shared `app_flow_hook_nonces` table (keyed by the flow or workflow id, so a
  replay is refused on every instance), 60 requests a minute per hook in the shared counters, JSON objects only, and
  the `untrusted-content` and `user-input` checkpoints before a run exists. `POST /hooks/workflows/<tenant>/<id>`
  (no session) answers `404` alike for an unknown workflow and for one that is off.
- **Off by default, owned, at the workflow's label.** A workflow's hook takes requests only after a holder of
  `workflows:manage` makes its secret and turns it on, and only while the published version's trigger has source
  `webhook`. Turning it on needs `agents:run`; the runs start as that person, loaded again on every request (active,
  `agents:run`, cleared for the workflow's label, in its workspace). The payload is checked against the trigger's
  output schema and becomes the run input; the run carries the workflow's label.
- **The secret** is 32 random bytes, shown once in the answer to `POST /api/workflows/:id/hook/secret`, sealed with the
  tenant key (`workflowhook:<workflow id>`), never in a version, a bundle or a view; rotation replaces it at once with
  no grace period and forgets the signatures seen. A bundle's webhook trigger arrives switched off with no secret.
- **Deliveries** are counted and the newest 50 kept per workflow (outcome, status, reason, run; no body, no address),
  and audited (`workflow.hook.received`, `workflow.hook.refused` with the reason and address).
- **Run retention never removes evidence (B-135).** The `workflow.retention` job deletes finished runs past the
  policy (tenant default 90 days, failed 180, at most 1000 per workflow; per-workflow overrides) with their steps,
  items, approvals and redriven dead letters. It leaves queued, running and waiting runs, runs finished in the last 24
  hours, runs with an open dead letter, runs of a person or workspace under a legal hold, and runs held as objects
  (`workflow-run` is a moderated object type, so a dual-controlled hold of scope `object` can name one); each held run
  is recorded once in `retention_skips`. Policy changes and every prune are audited (`workflow.retention.updated`,
  `workflow.retention.pruned`); an admin's prune now reaches only the workflows they may open.

## Saved connection queries and REST connections (1.8.0, Sprint 45, migrations 090 and 091)

- **Parameters are bound, never pasted (B-125).** A saved query's `:name` placeholders become the driver's own (`$1`
  for PostgreSQL, `?` for MySQL) and the values travel apart from the text; a JSON query's `{"$param"}` is replaced by
  the typed value as a JSON value, so it never becomes structure. Strings, quotes, comments, dollar quoting and casts
  are skipped when placeholders are found; an undeclared `:word` is refused. An `identifier` parameter stands only for
  a name its definition lists, quoted. Every value is typed and checked (required, allowed values, range, length,
  list size) before anything is sent.
- **Classified when saved, checked again at every run.** Saving runs the query parser with the allow-list once per
  name each identifier may stand for; a write is refused unless a connections manager marks the query as a write
  query, which then never runs (registered connections stay read-only). DDL, several statements, objects outside the
  allow-list and text the parser cannot read are refused, with no "run anyway". Each run classifies the bound text
  again against the allow-list in force, passes the `db-query` guardrail with the parameter values (a redaction
  refuses: it cannot be applied to bound values safely), runs in the driver's read-only transaction under the
  query's and the connection's row and time caps, and is masked like the data browser. Runs, refusals and failures
  are audited with the parameter names (`connection.query.run*`).
- **Rights.** Designing needs `connections:manage`; running needs `connections:query` (a new permission: connection
  admin, tenant admin, workflow admin and knowledge curator) and clearance for the query's label, which is at least
  the connection's; above it a query is a `404`. The tool `connections.query` also refuses anything above the label of
  the call. Knowledge sources need the curator's `connections:query` when added and then read as a service held to
  the source's label floor. App lookups read only queries or endpoints a connections manager offered to lookups, at
  most at the entity's label and within the reader's clearance, and a written value must be one of the options.
- **REST hosts only from the tenant's list (B-126).** A base URL (and an OAuth2 token URL) must name a host on the
  tenant's list of allowed hosts when it is saved; every request goes through `guardedRequest` with the operator's
  rules (internal addresses only as `SERVICE_ALLOWED_HOSTS` names them, metadata never) and the tenant's list again at
  dial time, the address pinned, redirects not followed, a Link header's next page followed only under the base URL,
  path parameters percent-encoded and kept under the base path, a timeout and a size cap (an answer cut at the cap is
  refused, never read short; `guardedRequest` now rejects instead of resolving a truncated body).
- **REST secrets sealed or in the vault.** The password, token, API key or OAuth2 client secret is sealed with the
  tenant key (`rest-connection:<id>`) or kept as a `vault:` reference resolved as whoever saved it; it is a
  `rest-connection` kind of `vault/credential-moves.ts`, so it moves to `kv/integrations/rest-connection/<id>`. A
  default header or endpoint query parameter that carries a credential takes a vault reference, never a literal.
  Secrets are scrubbed from problem details and never shown; reads are audited with host, status, pages, rows and
  size only.
- **Untrusted content.** Every REST answer's mapped rows pass the `untrusted-content` checkpoint (source `http`)
  before a tool, workflow, knowledge base, app entity or lookup gets them: a block withholds them, an annotation is
  carried with them. Knowledge chunks pass it again at retrieval, and tool results in the dispatcher.

## Schema changes and queues through data connections (2.0.x, migration 169)

Data connections stay read-only for queries; schema changes are a separate, narrower path (`connections/ddl.ts`,
`ddl-types.ts`, `service.ts` `previewDdl`/`applyDdl`).

- **A separate account.** A change runs only on the connection's admin account (`admin_credential`, sealed as
  `connection-admin:<id>`, or a `vault:` reference resolved as whoever saved it; a second field of the `connection`
  kind in `vault/credential-moves.ts`). The read account, OpenBao leases and cloud-account credentials are never used
  for it, and queries never use the admin account. Without one, preview works and apply is refused.
- **No free text to the database.** The console sends a structured definition; the server checks it against the
  vendor's types and rules and writes the statements. Names are plain identifiers quoted in the dialect; literals are
  escaped by type (BigQuery with backslashes). The three places an expression is accepted (a default, a CHECK, an
  index predicate) are scanned so they cannot end the statement, open a comment, leave a string or quoted name open
  or unbalance brackets (`expressionProblem`). A routine body goes inside a construct it cannot leave: a dollar-quote
  tag it does not contain, a quoted string, the BigQuery routines API's own field, or a single statement sent without
  multi-statement support. A body may still do anything the admin account may do when the routine is called; the
  account's grants are the limit.
- **What was reviewed is what runs.** Apply rebuilds the plan and refuses it unless its sha256 matches the preview.
- **Rights.** Setting the admin account and applying need `connections:ddl` (connection admin; system admin) and a
  sign-in or step-up within the window, from a browser session (an API key cannot). Preview needs
  `connections:manage`. The caller's clearance must cover the connection's label; a change that acts on an existing
  object (the table of an index or foreign key, a stream's consumer group, a binding's queue) needs that object on
  the allow-list. The `db-query` guardrail sees the statements; a block, approval or redaction refuses.
- **Audit.** `connection.admin-credential.set`/`.removed`, `connection.ddl.applied`/`.refused`/`.failed` with the
  statements, account and hash; credentials are scrubbed from driver messages.
- **Queues.** `GET /connections/:id/queues` reads on the read account and returns only allow-listed names; Redis
  `PUBSUB` and `XINFO` need those commands in the read user's ACL.
- **Editing and dropping.** An edit (`alter-table`, `replace-index`, a routine with `orReplace`, a non-SQL `edit`) is
  diffed against the object as the read account describes it at that moment (`describe`), never against what the
  browser sent, so a table changed after the preview gives another plan and apply refuses it (`409`). A plan that
  loses data (a drop; a dropped column; a type change that is not a pure widening) is `destructive`: apply needs the
  object's name typed back (`confirm`), and the audit entry records `destructive: true`. Edits and drops act only on
  allow-listed objects; a dropped object leaves the allow-list and a renamed table's entry follows it.
- **Known gaps.** MySQL, Oracle, Snowflake and BigQuery commit each DDL statement on its own, so a failure part-way
  leaves the earlier statements applied (the preview says so). SQLite (D1) changes needing a table rebuild are
  refused rather than rebuilt. A routine body read back is the catalog's text (PostgreSQL `BEGIN ATOMIC` bodies come
  back empty and must be retyped). A connection on OpenBao credentials keeps its admin account sealed in place; the credential move skips
  those rows.

## Privacy: image metadata in served copies (1.8.0, Sprint 47, migration 099)

Photos carry where and when they were taken and with what: EXIF (with its GPS IFD and a thumbnail of the original),
XMP, IPTC, comments, PNG text chunks, C2PA manifests (which may hold EXIF and location assertions) and data appended
after the image. B-142 takes all of that out of every copy of an image the file store serves, in process and without
an image library (`files/exif.ts`): only the container is rewritten, the pixels are never decoded or re-encoded.

- **What goes, what stays.** JPEG is rewritten segment by segment as it streams: APP1 (EXIF, XMP, extended XMP), APP3
  to APP13 and APP15 (Photoshop and IPTC, JUMBF), comments, non-ICC APP2 (MPF indexes of extra images), the JFIF
  thumbnail and everything after the end-of-image marker go; the ICC profile (APP2), Adobe APP14 (how to read the
  colours) and the image data stay, and EXIF Orientation is kept as a one-tag EXIF block so a phone photo is not shown
  on its side. PNG is rewritten chunk by chunk with an allow-list: critical chunks and the ancillary chunks that change
  how the image looks (`tRNS`, `cHRM`, `gAMA`, `iCCP`, `sBIT`, `sRGB`, `cICP`, `mDCv`, `cLLi`, `bKGD`, `hIST`, `pHYs`,
  `sPLT`, APNG's `acTL`, `fcTL`, `fdAT`) stay; `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`, `caBX` and unknown chunks go,
  and so does anything after `IEND`. WebP loses its `EXIF` and `XMP ` chunks and unknown chunks, with VP8X's flags and
  the RIFF size corrected; GIF loses comment extensions and application extensions other than looping and the ICC
  profile (XMP lives in one). WebP and GIF are cleaned in memory up to 32 MB; a larger one is refused (`413`) rather
  than served as it is.
- **Where.** Downloads of the current version and of older versions, previews (cleaned before they are stored and
  again when served, so previews drawn before 1.8.0 are clean too; a renderer that copies metadata into the PNG makes
  no difference), signed-in and anonymous link downloads, DAV `GET` (for anyone but the owner), avatars and group
  pictures, pictures crossposted to the AT-Protocol PDS, and the copy a vision model sees for a suggested alt text.
- **The original is intact.** The stored version is never changed, its hash is the uploaded content's, and its owner
  can download it as uploaded with `?original=1` (anyone else gets `403`); the owner's DAV client reads the original,
  so a sync reads back what it wrote. Such a download is audited `file.downloaded` with `original: true`; cleaned
  downloads carry `metadata: stripped`.
- **Fail closed.** An image that does not parse is not served as it is: a buffered copy is refused (`422`), a
  streamed one stops (the transfer ends short), a preview fails.
- **Alt text and descriptions** are written by people who may change the file, screened at `user-input`, stored in the
  clear beside the name and tags (`file_meta`, covered by the file's label) and searched with them. A suggested alt
  text comes from a vision profile through the gateway under the usual model governance and is never saved on its own.

## Scheduled delivery of views, reports and dashboards (1.8.0, Sprint 44, migration 104)

B-124 sends an app's view, report, dashboard or records on a schedule by email, to the file store or to a webhook
(`apps/subscriptions.ts`). A delivery leaves the console, so each one is decided again when it happens.

- **Rendered as the recipient, re-checked at every run.** No delivery is rendered as the subscriber for someone else:
  each email recipient's copy is rendered through `s.appExports.render` as that person, and the file store and the
  webhook get the subscriber's own render. Before every render the person must be active (not disabled or
  sanctioned), hold `records:read`, see the app, and be able to read the view (its owner or shared, its label within
  clearance) or entity; the render then applies their row and field policies, masks, clearance and, for objects over
  saved connection queries, `connections:query`. A refusal means nothing is sent, and the history and audit
  (`app.delivery.denied`) record why; the owner losing access fails the run.
- **Who may send where.** Subscribing needs `records:read` and read access to the object (checked as the subscriber
  when subscribing: a check render for reports and dashboards). Adding other recipients needs `apps:design` with the
  app's label within clearance, because it sends app data to colleagues on a schedule (each still sees only their own
  render). A folder destination needs `files:write` and membership of the folder's workspace; the copy takes the
  render's label. A webhook destination needs `webhooks:manage`, the integrations right that already governs outbound
  webhooks, since it sends data out of the system; these rights are checked again at every run.
- **Never to a host that is not allowed.** A delivery webhook goes only to a host on the tenant's list of allowed
  hosts; an empty list, which leaves ordinary webhooks to the operator's rules, allows no delivery webhook at all. The
  operator's rules apply on top, the address is checked again at connect time (`guardedAgent`), redirects are not
  followed, and a host that leaves the list stops deliveries at the next run. The object's label must be within the
  webhook's `maxLabel`. Bodies are signed: HMAC-SHA256 over `<timestamp>.<body>` with the subscription's own secret
  (random, shown once, sealed under the tenant key with `app-subscription-secret:<id>`), or Ed25519 with the tenant's
  published webhook key.
- **Sealed settings, no contents kept.** Name, parameters, filters, folder, webhook address and message are sealed in
  `app_subscriptions.spec` (`app-subscription:<id>`). The delivery history keeps time, destination, recipient, rows,
  size, outcome and reason, never content; the only copy of a render is the file-store copy a folder destination or
  an oversized email makes, which the file store scans, labels and governs like any upload.
- **Attachments are capped.** A file over APPS_DELIVERY_ATTACH_MAX_BYTES is not attached (nor put in a webhook body):
  it goes to the recipient's own file store and the email links to it, and opening the link needs a sign-in, so the
  email carries no bearer link to the data.
- **Unsubscribing.** Each email has a link signed with the platform key `link` over the subscription and the
  recipient; it stops only that person's email copies. Opening it (`GET`) changes nothing, so link scanners cannot
  unsubscribe anyone; the button or an RFC 8058 one-click `POST` does. The public route is rate-limited, `no-store`
  and `noindex`; a link that does not verify changes nothing.
- **Runs and failures.** Each due time is claimed once across instances; a run is retried with backoff, and a retry
  skips what was already delivered. APPS_DELIVERY_PAUSE_AFTER failed runs in a row pause the subscription (the
  breaker) and notify its owner; schedules run at most every APPS_DELIVERY_MIN_INTERVAL_MINUTES, and one person has at
  most 50 subscriptions. A tenant admin (`tenant:manage`) lists every subscription within clearance and may pause or
  delete one; only the owner changes, resumes or runs it. Audited `app.subscription.*` and `app.delivery.*`.

## Security scans as a promotion gate, and the emergency vault seal (1.8.0, Sprint 48, migrations 107 and 108)

**Scan gate (B-144, `security/scans.ts`).**

- **A result belongs to one digest.** Trivy JSON, SARIF and CycloneDX reports are parsed as untrusted input (JSON
  only, strings cut, at most 5,000 findings kept, a Trivy secret's matched text never read) and stored against the
  digest of an app package, a plugin bundle (or inline manifest) or a script image. A promotion carries an exact
  package (the tested one to production, or a chosen one to test), so a result can never apply to something else; an
  image named by a tag matches nothing, since tags move.
- **Where it runs.** Pipeline promotion to test and production, again when the deployment job runs (results and
  exceptions may change while an approval waits), plugin enablement and upgrade, and the SCRIPT_IMAGE_* setting at
  proposal and at approval. Rollbacks are not gated, so undoing a deployment stays possible during an incident.
- **No result: allowed with a warning by default.** Promotion, plugins and script images worked before scans existed,
  and most installations have no CI hook yet; refusing every unscanned artefact the day this lands would stop every
  deployment at once. Each such pass is audited `security.gate.warned` and shown on the promotion dialog, and a
  platform admin turns `missing` to `refuse` once results flow.
- **Who.** Reading and uploading results take the kind's own permission (`apps:design`, `plugins:manage`,
  `platform:manage`), results are filtered by the artefact's label, and the policy, deleting a result and approving an
  exception take `platform:manage`. An exception (a reason, an expiry of at most a year, the finding and optionally a
  package, kind and digest) counts only once a platform admin other than its requester approves it, and only until it
  expires; the approver is recorded as who accepted it. Audited `security.scan.*` and `security.gate.*`.

**Emergency vault seal (B-145, `vault/seal.ts`).**

- **Dual control, or the quorum.** "Seal the vault" is a proposal by one platform admin that a second, different one
  approves (each with a recent sign-in; the proposal expires in an hour). `platform:manage` is the right because a
  seal stops every tenant, and two people because a seal is a platform-wide outage. The break-glass path seals with
  the escrow threshold of shares and no session: whoever holds k shares can already rebuild the key-encryption key
  (`kms:recover`), so it gives them nothing new, and it still works when admin accounts are the problem.
- **What drops.** On every instance (the bus, the persisted flag read at start and polled every 5 s): unwrapped data
  keys, the keyring's HMAC secrets, opened OIDC/SAML private keys, keyword-term keys, calendar feed keys, identity
  providers with resolved secrets and dynamic database credentials; jobs stop being claimed. The KMS adapter
  (`guardKms`), the data keys and the keyring refuse every key operation with 503 "Vault sealed".
- **The signer seals too.** A new protocol message `seal` makes the signer drop its key-encryption key, held-key
  secret and opened private keys (the buffers are overwritten); `unseal` takes the escrow shares and accepts only the
  key it started with (by key check value), so a stolen `SIGNER_TOKEN` cannot unseal it. A marker file beside the
  socket keeps it sealed across restarts.
- **What still answers.** `/healthz`, `/readyz` (ready, with `vault: sealed`, so load balancers keep routing to the
  unseal page), `/metrics`, the console's static files, `GET /api/auth/session` (as signed out) and the unseal API.
  Everything else, sign-in included (a session needs the session key), answers 503.
- **Unseal needs the quorum.** Each share is checked by its own check value and escrow id, held in the receiving
  instance's memory only (never stored, never logged), and at the threshold the key is rebuilt and checked against
  the escrow's key check value and the running key before anything reopens. Every step is audited; the audit chain is
  a hash chain that needs no key, so seal, shares and unseal are recorded while sealed. Data is not re-encrypted:
  what was sealed before reads back the same.

## App-local roles and use-limited credentials (1.8.0, Sprint 48, migrations 105 and 106)

**App-local roles (B-143, `apps/roles.ts`).** Each app keeps its own role catalogue, and row and field policies may
name a role (`app_role`). The design keeps a role from ever being a way around anything else:

- **Only a policy subject.** A role grants nothing by itself. It counts only where an enabled policy of the entity
  names it, and policies only narrow: a reader still needs `records:read` (`records:write` to change records), labels
  apply before any policy, the app's workspace and group scope decide who sees the app at all, and an entity without
  policies is open as before whatever roles anyone holds. Designers (`apps:design`) stay outside policies, as before.
- **Inside its app.** Roles and their assignments are rows of one app; the same name in another app is another role,
  and an assignment never reaches past the app's policies.
- **Who manages them.** The catalogue and assignments need `apps:design` with the app's label within the caller's
  clearance, the right that writes the policies a role feeds, so no tenant administrator is needed and nothing a
  designer could not already grant through a `user` or `group` subject becomes possible. A group must be one the
  designer can see, and for a workspace app in its workspace; a workspace default role is limited to the app's own
  workspace.
- **Groups count now.** A group's members hold the role while `s.groups.subjects` counts them (active, not banned or
  suspended, not departed, cleared for the group's label), so leaving or being suspended ends it at the next request.
- **Environments.** Packages and promotions carry the catalogue, never the assignments: who holds a role in
  production is decided in production. A package whose policy names a role it does not carry is refused. Every change
  is audited `app.role.*`, and explain shows which role gave a grant and how it is held.

**Use-limited credentials (B-146).** An API key (and the lease behind an `exai_k2_` key) or an embedded session may be
accepted at most `max_uses` times; `1` makes a one-shot key for an embed or an agent task.

- **The count decides across instances.** Each accepted use is one conditional update (`uses_left = uses_left - 1
  where uses_left > 0`) on the key's row or its lease, so parallel requests on any number of instances sharing the
  database never pass the limit; a cached lease is never trusted for the count.
- **Spent on authentication.** A use is spent when the presented secret matches a live key, before scope, app and
  request-signature checks, so a refused request also counts: the limit bounds how often the secret can be presented,
  not how many requests succeed.
- **Revoked at zero, through the key service.** The last use is answered; the key is then revoked through
  `ApiKeyService` (its record, then its lease, so every instance refuses it at once), audited `apikey.exhausted`, and
  its owner sent a security notice naming the key by name and prefix (never the secret). A use-limited embedded
  session is revoked the same way by the embed service and audited `app.embed.session.exhausted`.
- **No cost without a limit.** A key without `max_uses` makes no extra query or write per request.

## Push devices and notification preferences (1.9.0, Sprint 49, migrations 115 and 116)

**Devices (B-150, `platform/push-devices.ts`).** A push token or Web Push subscription is a credential for reaching a
person: whoever holds it can send to their phone or browser through the provider. So:

- **Sealed, never answered.** The token, or the subscription's endpoint and its `p256dh` and `auth` keys, is sealed
  with the tenant key (`push-device:<id>` as associated data) and opened only by `forDelivery`, for the delivery job.
  No HTTP answer, audit entry or log line carries it: the console shows a fingerprint, 12 hex digits of a digest of
  the token or endpoint. The lookup that finds a re-registration is a SHA-256 over tenant, provider, app id and the
  token, unique per tenant, so registering the same token twice updates one row.
- **An ended device holds nothing.** Revoking a device, a provider reporting it gone, or its sessions ending clears
  the sealed value at once. Idle devices (`PUSH_DEVICE_IDLE_DAYS`, 90 by default) and ended rows (after 30 days) are
  deleted. A person has at most 50 active devices.
- **Ends with the sessions.** Every `SessionService.revokeAllForUser` (sign out everywhere else, password change or
  reset, an admin disabling the account or changing its access, SCIM and directory deactivation, sanctions) revokes the
  person's devices except those registered from the kept session; revoking a session, signing out included, revokes
  the devices registered from it; disabling or offboarding a tenant revokes all of them, and the purge deletes the
  rows. Like trusted devices, they are ended through the session service, never by a table update elsewhere.
- **Own devices only.** `/api/me/devices` acts on the caller's own devices (another person's id is a 404); an
  administrator lists and revokes a person's devices with `users:manage`, in their own tenant. Every change is audited
  (`push.device.*`).

**Preferences (B-153, `platform/notification-prefs.ts`).** A person cannot silence what they must see:

- **Mandatory kinds.** Security alerts (password, factors, keys, sessions, applications, sign-in from a new device or
  network, account changes by an administrator) are mandatory in every tenant, and a tenant admin (`tenant:manage`)
  may make more kinds mandatory. A mandatory kind always goes out at once on every channel; neither a personal choice,
  quiet hours nor a digest holds it, and the API refuses (409) a change that would.
- **Fail open, as before.** With no preferences every decision is "now", and an error reading them delivers the
  notification rather than losing it.
- **Held content is sealed.** A notification held for a digest keeps its title sealed with the tenant key; the
  digest email carries titles only, and not those of notifications labelled above `internal`.

## Push providers and delivery (1.9.0, Sprint 49, migrations 117 and 118)

- **Credentials are references.** A provider's credentials (the APNs `.p8` key or certificate and its key, the FCM
  service account, the VAPID private key, a vendor's token or password) are only `vault:` references in its config; a
  literal in a `…Ref` field, a secret-named header, a credential-looking body field or query parameter, or a URL with
  user information is refused when it is saved. A tenant's references must be readable by the admin saving them
  (`secrets:read` and the path policy) and resolve at use as that admin (`VaultService.resolveFor`), so a revoked grant
  or a disabled admin stops them. A platform provider's references live in the vault's platform scope under
  `sys/kv/push/…` and resolve as the internal service `push`, granted read on that path once (an audited vault grant).
  Values are read into memory for at most five minutes per provider and never logged, audited or returned; the
  console stores a pasted credential through the vault and keeps only the reference.
- **Egress.** Every outbound connection goes through `platform/egress.ts`: cloud metadata, unspecified, multicast and
  broadcast addresses are always refused; internal addresses only when SERVICE_ALLOWED_HOSTS names them; public hosts
  when the kind names them (APNs `api.push.apple.com` and the sandbox, FCM and Google's token endpoint, the browsers'
  push services for Web Push endpoints, which come from the subscription) or the tenant's allowed hosts (a platform
  provider: SERVICE_ALLOWED_HOSTS). A Web Push endpoint is checked like any other host, so a crafted subscription
  cannot point delivery at an internal service. Redirects are never followed.
- **HTTP/2 through the guard.** APNs and FCM use `guardedHttp2Connect`: the host is resolved once, every address
  checked, and the TLS socket dialled to a checked address with the name used only for SNI and certificate
  verification, so a later DNS answer cannot move the session; `https` only (no h2c), server push refused, each
  request capped at 64 kB and 10 s. One session per provider and origin is reused and closed after a minute idle; a
  client certificate (APNs certificate auth) pins its session to its provider.
- **Payload encryption.** Web Push payloads are encrypted as RFC 8291 (`aes128gcm`, an ephemeral P-256 key per
  message, HKDF keyed by the subscription's auth secret) with node:crypto; the code is checked against the RFC's
  Appendix A vector. VAPID tokens (RFC 8292) are ES256, 12 hours, per push service origin.
- **Content follows labels.** A notification labelled above the provider's `contentLabel` (`public` by default, at
  most `internal`) is sent with a neutral title and no body; the console's own socket carries the full notification,
  as the in-app bell does. The service worker opens only a route of this console, never a link from the payload.
- **What the log keeps.** `push_deliveries` keeps, per attempt, the person, notification and device ids, the provider,
  channel, notification kind, outcome, the provider's status and short reason code, latency and attempt: never a token,
  a credential, the payload or the notification's text. It is kept 30 days. Audit: `push.provider.created`,
  `.updated`, `.checked`, `.deleted` and `push.test.sent`, with no credential or token in their detail.
- **Who.** Platform defaults need `platform:manage`; a tenant's overrides need `tenant:manage` (the tenant admin
  permission that already governs the tenant's integrations, so no new catalogue entry or role change). Saving a
  provider, storing a credential and generating keys need a recent sign-in. A test send reaches only the caller's own
  devices. A socket acknowledgement counts only from the recipient's own socket.

## Plans and subscriptions (1.9.0, Sprint 51, migration 124)

- **Who.** The plan catalogue is platform-wide and kept by holders of `platform:manage`, in a browser session signed in
  within `STEPUP_WINDOW_SECONDS`. What a plan charges or includes (prices, allowances, entitlements) is a version that
  a second platform admin approves before it is in force (dual control, like custom roles); the proposer cannot
  approve it. Names, visibility, state and trial length change at once. A tenant's subscription is changed by its
  billing or tenant admin (`billing:manage` or `tenant:manage`), the tenant always from the session; a system admin
  may name another tenant. Only platform admins put a tenant on a private plan, set a trial or a fixed end. Reading
  takes `billing:read` and the `internal` clearance.
- **History.** Subscriptions are never edited in place without a record: every change and every transition time
  brings is a row of `billing_subscription_events` with the state after it, so a statement can ask what applied at
  any moment. Approved plan versions are never changed.
- **Money.** Integer minor units; proration over whole seconds with one rounding per amount (half away from zero),
  computed with BigInt.
- **Statement PDF.** Built from the stored statement only, for the caller's tenant (another tenant's id is not
  found); its download is audited.
- **Stripe.** Subscription and discount lines are separate invoice items with their own idempotency keys, so a retried
  push never bills twice; tests use a fake Stripe only.

## Spam and flood checks and moderation metrics (1.9.0, Sprint 50, migrations 122 and 123)

- **What is stored.** Rate windows are counters in the rate limiter's store (Redis or memory), keyed by tenant,
  surface and an account id, an IP range (/24 or /56, never the full address) or `*`, expiring after two windows.
  `spam_fingerprints` keeps a 64-bit SimHash of each screened text, its four bands, the account, the surface and a
  64-bit hash of where it went (never the conversation or post id itself), for 24 hours. `spam_domains` keeps the
  domains linked in the tenant with first and last use and a count, pruned after 90 days unused. `spam_scores` keeps
  per account the score, its level and reasons (signal, value, threshold, points), pruned after 30 days.
  `spam_responses` keeps the kind, surface, score, reasons, the warning and flag ids. `moderation_metrics_daily` keeps
  counts and sums per day (rule and set ids with the rule's name, actions, queue names, response kinds).
- **Sealing.** No text is stored by the checks: a text is read in memory, reduced to its fingerprint, link domains and
  counts, and dropped. A case's flag carries no excerpt, only the reasons and counts; the reviewer sees content only
  where moderation already shows it (a held write's own review). Nothing here needs a data key.
- **Shadow first, never a ban.** The checks are off until an admin saves a policy, and every surface then starts in
  `shadow`: scores and `spam.scored` audits only (`wouldApply` says what enforce would do). Enforce applies slow mode,
  a hold for review, a temporary limit and a case, each for a set time; there is no response that suspends, bans or
  ends sessions, and the warning sanction that stands for a response is `warn` only. The person is told and appeals
  through the existing appeals; an upheld appeal lifts the response. Admins and the allow-list are exempt.
- **Never in the way.** Recording is fire and forget and time-boxed; the gate before a write fails open after 150 ms,
  so a slow or unreachable counter store never delays or refuses a write. With Redis degraded the windows count per
  instance (as the rate limits do), shown in `GET /api/moderation/spam/signals`.
- **Who.** Reading needs `moderation:review`; the policy `moderation:manage`; lifting `moderation:sanction`; the CSV
  export `moderation:review`, audited `moderation.metrics.exported`, with formula-looking cells quoted as text.

## Rule-set tests, term lists and nested conditions (1.9.0, Sprint 50, migrations 119 and 120)

- **Who.** Everything here is guardrail configuration, so it sits under `guardrails:manage`, the permission that
  already governs rule sets (the Guardrail admin role, MFA required, and System admin). The platform baseline's cases
  are written only by platform guardrail admins, as its rules are. Term lists are not readable by anyone else: a
  deny list can be a list of slurs.
- **Test texts are sealed (B-155).** A case's text may be a harmful example, so it is sealed under the tenant's data
  key with `guardtest:<id>` as associated data, keeps a label, and is returned only to a reader cleared for it
  (otherwise `text: null, hidden: true`); nobody can write a case above their own clearance. Runs keep verdicts and
  rule ids, never text. Imports from recorded decisions and replay hits read the sealed text of `guard_decisions`
  (kept 7 days) only for decisions of the tenant, of the set's workspace for a workspace set, and at or below the
  importer's clearance, and the case keeps the decision's label. A replay's result holds decision ids, not text.
- **The gate cannot be skipped.** Publishing, approving (dual control) and promoting a rule run every case against
  the version that would apply, as if every rule enforced, and refuse with 409 until all pass; refusals and passes
  are audited (`guardrail.tests.gate.refused`, `.gate.passed`). A set without cases is unchanged. The gate is in
  addition to dual control and to the baseline lock, never instead of them.
- **Term lists cannot backtrack or blow up (B-156).** Entries are matched by one Aho-Corasick automaton per version
  (linear in the text however many entries; no regular expression is built from entries), domains by a suffix walk
  over a set. A list holds at most 50,000 entries of at most 200 characters; CSV bodies are capped at 8 MB. Versions
  are immutable, so a rule pinned to a version keeps its meaning; a list still used by a rule cannot be deleted, and a
  rule may name only its own tenant's lists (none in the platform baseline). Exported CSV quotes cells a spreadsheet
  would read as a formula.
- **Normalisation is a skeleton, not a guarantee.** Case, accents, compatibility forms (full-width), a subset of the
  TR39 confusables (Cyrillic and Greek lookalikes), leetspeak, zero-width characters and split letters are folded;
  other scripts' lookalikes, images of text and paraphrase are not. Folding `1` and `l` to `i` widens matches by
  design: test a list with its live test and with rule-set cases before enforcing it.
- **Conditions fail safe (B-157).** A tree is at most 4 groups deep and 30 leaves; its patterns are compiled with RE2
  at save time. A classifier leaf that cannot answer makes the whole rule's `onError` decide, as a classifier rule
  does. A fact that is not known (no account, no spam score within its time box) makes its leaf false, so a rule never
  fires, and never fails, on what it cannot know; `none` over an unknown fact therefore matches. The account age is
  read from the user row; the facts `surface` and `channel` come from what the calling feature passes, not from the
  person.

## The tenant sign-in policy and OAuth client settings (1.9.0, Sprint 55, migrations 129 and 130)

- **Floor and bounds.** A tenant's sign-in policy (B-190) can only tighten the platform: passwords of at least 12
  characters always; at most `LOCKOUT_MAX_ATTEMPTS` attempts; sessions and the step-up window no longer than
  `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` and `STEPUP_WINDOW_SECONDS`. Values out of bounds are refused at
  save (400) and held to the platform's current bounds at read, so lowering a platform setting later applies to
  every tenant. Without a policy every check is today's.
- **One password pipeline.** Every new password (Settings, reset and invitation links, sign-up, admin create and set,
  a CSV import's `password` column) goes through `SigninPolicies.checkNewPassword`: the policy, the tenant's deny
  words, then the leaked-password lists, in that order. Character-class rules are off by default (NIST SP 800-63B);
  forced expiry is off by default and saving it returns a warning. The history keeps only argon2id hashes of earlier
  passwords, compared by verifying, and is deleted when the tenant turns it off or removes its policy. "Too close to
  the old password" is checked only when the person typed the old one; nothing about the old password is stored.
  Import reports carry the reason a password was refused, never the password.
- **Never a lockout by policy.** A correct password that no longer meets the policy (or has expired) signs in to the
  `password` stage, after the second factor, so a weak or old password alone never reaches anything but the change
  form. Restricting the second-factor kinds refuses new factors of other kinds, but an account whose factors are all
  of another kind keeps signing in with them.
- **Sessions.** The tenant's shorter idle and absolute lifetimes are applied when a session is resolved (table and
  lease sessions alike); the effective policy is cached for 30 seconds per instance and dropped on every instance
  through the bus when it changes.
- **OAuth (B-191).** Authorization codes live 10 to 600 seconds (60 by default); access tokens at most 30 minutes, the
  deny-list's horizon. PKCE can be required of every client; a public client always needs it and always rotates its
  refresh tokens. A reused refresh token revokes its family, recorded in `oidc_refresh_families` and audited
  `oidc.refresh.reused`. Keeping a refresh token without rotation is allowed only for confidential clients and turns
  off reuse detection for that client. A per-client rate limit counts in the shared counter store. A client set to
  "never ask" skips the consent screen; self-registered (RFC 7591) clients cannot be set so.
- **Audit.** `identity.policy.updated`, `identity.policy.reset`, `identity.policy.change_required`,
  `oidc.client.settings.updated`, `oidc.client.settings.defaults_updated`, `oidc.consent.granted`, `oidc.consent.denied`,
  `oidc.consent.withdrawn`.

## Leaked-password lists, checks and deny words (1.9.0, Sprint 55, migration 131)

- **No plain text at rest.** A plain-text list is hashed line by line as the upload streams in (SHA-1 or NTLM, the
  list's kind) and each line is dropped at once; only fixed-width binary digests reach the blob store (the staging
  object, the shards, the Bloom filter) or the sort's work files (a private `0700` directory under `LEAKED_WORK_DIR`,
  removed after every build). Invalid lines are reported by line number only; nothing of a line is logged. HIBP counts
  are read only to drop padding and are never stored. The suite searches the blob store, the work directory and every
  database table for a sample password after an import.
- **Bounded memory.** Uploads are streamed (never parsed whole, capped by `LEAKED_UPLOAD_MAX_BYTES`, 413 above it);
  a build partitions by the first byte into temporary files, sorts one bucket at a time in memory (64 MB budget,
  partitioned again past it), and cuts shards as it goes. A shard larger than the budget (hashes that are not
  uniformly distributed, a crafted list) stops the build. Checks keep each version's Bloom filter in memory (at most
  `LEAKED_BLOOM_MAX_MB`; a larger list gets a higher false-positive rate, shown on the version) and shards in a
  least-recently-used cache of `LEAKED_CACHE_MB`.
- **What a person learns.** A check answers found, not found or unavailable: never which list, how often, or a count;
  the problem, the sign-in answer, the security notice and the report carry no list name. Platform list names are
  shown only to `platform:manage`; a tenant admin sees how many platform lists apply.
- **Fail modes.** A list that cannot be read is accepted (fail open, the default and the `BREACHED_*` behaviour) or
  refused with 503 (fail closed), by the tenant's setting; either way `password.breach_check.unavailable` is audited.
  At sign-in an unreadable list never stops the sign-in: it is retried at the next one.
- **Sign-in.** A local account's password is checked once per new list version (recorded in
  `leaked_password_checks`, which holds version ids and times, never a hash). Block refuses only after the right
  password, like the other post-password refusals, so it tells a guesser nothing a correct password would not. A
  directory account is not checked at sign-in (its password is changed in its directory).
- **The HIBP mirror** is an explicit `platform:manage` action against `BREACHED_HIBP_URL`, rate-limited
  (`LEAKED_MIRROR_RPS`), with redirects refused; it sends only the five-character range prefixes, as the range API
  intends. `passwords:check` sends only the first five hex characters of a hash to any source and compares locally.
- **Deny words** are the tenant's own words (not secrets): the refusal names the matched word. Matching folds case,
  accents, lookalike letters, leetspeak and separators; words shorter than three letters after folding are ignored.
- **Audit.** `passwords.list.created`, `.updated`, `.deleted`, `.uploaded`, `.built`, `.failed`, `.activated`,
  `.version.deleted`, `.mirror.started`, `.mirror.resumed`; `passwords.settings.updated`; `password.leaked.signin`;
  `password.breach_check.unavailable`.

## CA settings, CA tokens and member certificates (1.9.0, Sprint 55, migrations 127 and 128)

- **Settings (B-187).** Certificates › Settings needs `pki:manage`; the platform scope also needs `platform:manage`
  and a recent sign-in. Every value is checked against its range (`422`); an environment variable set explicitly is a
  floor a saved value may tighten but never loosen, and for a tenant the platform's value is the floor. Changes to the
  root and intermediates (subject, key algorithm, validity, path length) are under dual control: a second platform
  admin approves, never the proposer, and the values are read only at the next rotation or re-issue. Approving changes
  no key, certificate or issuer row; a re-issue keeps the subject so issued certificates keep chaining. Saves are
  compare-and-set on a version, cached 30 seconds per instance and refreshed over the bus.
- **Key custody.** Every new key (P-384 and RSA 4,096 tiers, OCSP responders, token signers) is made and used in the
  signer or OpenBao, as before. A token signed with RSA-PSS is verified locally before it is handed out; a signer from
  an earlier release, which ignores the PSS request, is caught by that check (`502`).
- **CA tokens (B-188).** Issuing and revoking need `pki:manage`; validating, introspecting and refreshing need
  `pki:tokens`, the tenant's own tokens only. Only the token's id and SHA-256 are stored; the text is shown once. A
  use-limited token spends in one conditional update (`uses_left > 0`), so concurrent validations never exceed its
  uses. Validation checks the row (state, expiry, uses), the signer's certificate and intermediate (not revoked, not
  expired) and the signature against the signer's public key. Revoking the signer's certificate or intermediate ends
  its tokens through a revocation listener and at the next validation.
- **Member certificates (B-189).** Off by default. The key made for a member is sealed with the tenant key (associated
  data `pki-member:<id>`) until they pick it up once (a recent sign-in), then deleted; offboarding destroys the tenant
  key with the rest. Certificates are revoked when the account is disabled, deactivated or deleted by SCIM, and at
  tenant offboarding. Joins and departures are read from the audit chain, and a sweep catches anything missed.
- **Forwarded client certificates.** The app never terminates TLS. The proxy's headers (`PKI_CLIENT_CERT_HEADER` and
  `PKI_CLIENT_CERT_VERIFY_HEADER: SUCCESS`) are believed only from a socket peer listed in `PKI_CLIENT_CERT_PROXIES`
  (empty by default: never); `X-Forwarded-For` and `TRUST_PROXY` play no part, and a refused header is logged. The
  certificate is then checked independently of the proxy: a valid, unexpired member certificate of this CA, signed by
  its intermediate, whose SAN still names the account. Certificate sign-in is one factor (the tenant's second-factor
  policy applies after it). mTLS for the API needs `X-Client-Cert-Auth: 1`, which a cross-site page cannot send
  without a preflight, so a browser holding the certificate does not become a CSRF vector.
- **Audit.** `pki.settings.*`, `pki.token.*`, `pki.member.*`, and `auth.login` with `target.method: certificate`.

## Albums, album share links and upload links (1.9.0, Sprint 53, migrations 135 and 136)

An album (`files/albums.ts`) points at files; it never copies them, so quarantine, scanning, labels, versions, the
metadata stripping of served copies and alt text all stay the file store's. What an album adds is an audience, and
the rule below keeps that audience from reaching anything its members could not have been given anyway.

- **Audience.** A workspace album is seen by its workspace's members, a group album by whoever counts as a member of
  the group now (`s.groups.subjects`: active, not banned or suspended, cleared for the group, in its workspace), a
  personal album by its owner and the people it names. In a workspace or group album a role (viewer, contributor,
  editor) is held only by members of that workspace or group, and is re-checked on every read: leaving the workspace
  or the group ends the role at once.
- **The access rule.** An item is shown to a person only when, now: they are in the album's audience; the file is
  ready, not in the trash and not taken down; they are cleared for its current label and the label fits the
  audience's ceiling (the workspace's ceiling, the group's label); and either they can read the file through its own
  access (its workspace, a share, a group grant) or the person who added it could share it with them. Adding takes
  the right to change the file (a member of its workspace, cleared for its label: what a file share takes), and that
  is checked again on every read, so an album's grant is never more than a share the adder could have made, and it
  ends when the adder loses the file. The album never widens who may read a file beyond what its audience may see,
  and an editor below an item's label can neither see nor remove it.
- **Labels.** The album's floor label covers its title and description and is the gate for opening it; its effective
  label is the high-water mark of the floor and its items' labels, used for its feed posts, audit entries and
  notifications. An item above someone's clearance is never shown to them, counted for them, put in their zip or
  named in their notification.
- **Share links** follow the anonymous file links' rules (B-706): the tenant's anonymous-link setting, a public album
  floor, the tenant's maximum lifetime, and a reader whose clearance is `public`, so only public items are served,
  through the same access rule. The token (`exa_`, 32 random bytes) is shown once and kept as an HMAC under the `link`
  key, and travels in POST bodies only. A password is hashed with argon2id; attempts are limited per link and address
  range (10 in 15 minutes, counted in the shared counters, every attempt counted so a right guess past the limit also
  waits), and a wrong one is audited. Opening a link mints media addresses (an HMAC over the link, the file, the kind
  and an expiry 15 minutes ahead) that are checked again against the link and the access rule on every fetch. A
  `view` link serves previews and cleaned copies inline; only a `download` link serves attachments and the zip.
  Revocation, expiry, a deleted album, a floor no longer public and a tenant that turned anonymous links off all end
  the link with the same `404`. Each open and download is audited (`album.share.viewed`, `album.share.downloaded`)
  with the address in the actor, as file links keep; nothing else about the reader is stored.
- **Upload links** (`exu_` tokens, kept and carried like share links, the token in a request header) take a place
  atomically before any byte is read (no more than `max_files`), cap each file at the link's size and at
  FILES_MAX_BYTES while it streams, and leave the storage quotas in force. Each upload is a file of the link's
  creator in the album's workspace, labelled with the album's label, checked against that workspace's ceiling and the
  creator's clearance; it goes through quarantine and the scan (type from the bytes, ClamAV when configured, DLP for
  text), and joins the album only when the scan passes (`album.upload.added`); a rejection keeps the scanner's reason
  for the owner (`album.upload.rejected`). The uploader's name is stored as given, sealed under the tenant key, and
  shown to the album's editors only. Uploads are rate-limited per address and recorded with the spam and flood
  signals (`s.spam.record`: the link as the account and the address range), so a flood through one link or from one
  range scores like any other.
- **Zip downloads** stream through `platform/zip-writer.ts` (`zipStream`: stored members with data descriptors, the
  central directory written last, no Zip64, so at most about 4 GiB) from the cleaned copies; nothing is held in
  memory but the directory. Each is audited `album.downloaded` with the files it held.
- **Feed and notifications.** An album is posted only to its own workspace's or group's feed, labelled at least as
  high as the album; the card opens the album through the album's access, so a reader of the post sees no more of it
  than the album's audience may. Personal albums are not posted. Notices of new items (kind `album`) are batched per
  album and window and count only what each recipient may see.

## Group proposals, voting and decisions (1.9.0, Sprint 53, migrations 133 and 134)

- **Content.** A proposal's title, text, options and the action it would take are one document sealed with the tenant's
  key as `group-proposal:<id>` and labelled as its group is; only the kind, the method, the times and the counts are in
  clear. Readers are those who read the group's content. Notifications and audit entries never carry the text (the
  tally records option ids, not their labels).
- **Who decides.** Only the electorate fixed when voting opens votes: members whose membership is in effect then
  (active, cleared for the label, not suspended or banned) and who hold more than a guest's rights. Joining later gives
  no vote, and a member removed or banned since loses it (they no longer read the group).
- **Carrying out.** A passed decision runs through the group's own services as the group: `groupPrincipal`
  (`groups/service-principal.ts`) holds no tenant role or scope, and `GroupService.accessOrNull` gives it the owner
  tier's rights in its own group only, recognised by object identity (a request cannot forge it). Every rule of those
  services still applies: the last owner stays, a ban refuses an invitation, the budget never goes below zero. One
  conditional update claims the decision (`carry_claimed_at`), so it is carried out at most once, however many
  instances close it; a spend's ledger entry is unique per proposal as well. Owners may require their confirmation
  for chosen kinds.

### Secret ballots and what they do not hide

What is stored: a ballot row with a random 128-bit id (not a ULID, which would carry a time), the choice, the
commitment HMAC(link key, proposal id, ballot id, choice, nonce) and the SHA-256 digest of a change token; no voter and
no time. Who voted is a separate row (proposal, user) with nothing about how. The audit chain records `group.vote.cast`
and `group.vote.changed` with `secret: true` and no choice or ballot id. The voter alone is given the receipt (ballot
id, choice, nonce, commitment) and the change token; the ballot id and token travel in the request body, never the
URL, so request logs do not carry them. At close the list of (commitment, choice) is published, the tally is computed
from it (anyone holding the list can recount it), its digest goes into the audit chain, and the change tokens'
digests are deleted. A voter finds their commitment with their choice in the list (`verify-receipt`); a missing or
altered entry is evidence the count is wrong.

What a server administrator could still learn:

- **During voting, by timing.** Someone watching the database while people vote can correlate the moment a
  participation row appears with the moment a ballot row appears (or changes), and so link a voter to a choice. The
  rows carry no timestamps, but their physical order can (SQLite row ids, PostgreSQL heap order, MySQL's clustered
  index pages, the write-ahead log, replication streams, backups taken mid-vote and the audit chain's sequence beside
  the ballot table's insertion order all keep an order). Nothing here defeats an observer of the live database.
- **The server process itself** sees who submits which choice when the request is handled; it does not keep it, but a
  modified server, a debugger or verbose request-body logging would.
- **A change of vote** is linked to the voter at the moment of the change (they present the ballot id and token as
  themselves); after close the token's digest is gone.
- **Small electorates and unanimous results** reveal choices by arithmetic, as in any vote.
- **The receipt proves inclusion, not secrecy against coercion:** a voter can show their receipt to someone else, and
  the server could in principle give two voters the same commitment if it were malicious. The receipt lets a voter
  detect their ballot being dropped or altered, not a server that lies consistently to everyone.

Without migrations 133 and 134 the feature reports itself unavailable and changes nothing.

## Active Directory, cloud directories and Exprsn platform accounts (1.9.0, Sprint 54, no migration)

- **Active Directory (B-182)** is asked over LDAPS or StartTLS only, with the certificate verified; a plain `ldap://`
  bind is refused at save and when the store is built, in every environment. Domain controllers named by DNS SRV
  records pass the same host checks as configured ones (`IDENTITY_ALLOWED_HOSTS`), and the checked address is the one
  dialled. Disabled, locked and expired accounts are refused from their flags before the password is sent; an empty
  password is never bound (AD treats it as anonymous). User input in filters is escaped (RFC 4515), and the
  objectGUID filter is sent as bytes. Only refusals that follow the right password (expired, must change, account
  expired) are told in words; locked and disabled answer like a wrong password, so a guesser learns nothing new.
- **Cloud directory pulls (B-183)** use the client credentials grant (Graph) or a service account's signed assertion
  (Google) with read-only permissions. Their credentials are `vault:` references only, read as the admin who saved
  the store; tokens stay in memory and never reach the database, the logs or a test answer. Requests go through the
  egress guard with the operator's service policy (metadata addresses always refused, public ones refused under
  `SERVICE_INTERNAL_ONLY` unless allow-listed, the connection pinned to the checked address, no redirects, capped
  answers), and a paging link is followed on the API's own origin only. A directory that cannot be read changes
  nobody at sync and refuses the sign-in (never a fall back to the ID token's differently named groups).
- **Exprsn platform accounts (B-184):** authorization code with PKCE (S256) and a single-use state bound to the
  browser; the client secret a `vault:` reference; the access token used for userinfo (and memberships), revoked
  afterwards, never stored. The link is the platform's account id, an address only when the platform says it is
  verified, and a username of another store is refused rather than merged. Saving or changing such a store needs
  `platform:manage` besides `identity:manage`.
- **Platform CA tokens on the API (B-184, last part).** Off until a store opts in (`acceptApiTokens`). The tenant comes
  from the store whose CA domain and trust anchor match, never from the token or the body; several matching tenants
  must be told apart with `X-Exprsn-Tenant`, else `401 tenant_ambiguous`. The signature (RSA-PSS SHA-256) must verify
  under a signing certificate the store's anchor issued. For v2 tokens (`sigVersion: 2`, the platform's QA-1 fix) it
  covers every presented field, nested ones included, as canonical JSON; a token whose signature does not cover what
  it presents is refused (`signature_invalid`), and its signed claims must equal the CA's answer. For legacy v1 tokens
  the platform's signature does not cover the nested objects (its `JSON.stringify` replacer applied at every depth),
  so the account, permission bits and resource are read from the CA's validation endpoint (service credentials as a `vault:` reference, egress-guarded, answers cached at most
  300 seconds, so a revocation takes effect within the store's `tokenCacheSeconds`); a presented account id that
  differs is refused. Only time-limited tokens, with 60 seconds' skew. The person is the account linked to the
  platform account id through the store; nobody is created from a token. Permissions are the account's roles narrowed
  by an explicit table of bits (an unlisted bit grants nothing); no CSRF, no step-up, admin roles that need MFA
  unusable. Refusals count towards the failed-credential limit and are audited rate-limited
  (`identity.platform_token.refused`, the reason only, never the token or its id, which is the platform's own bearer).

## Feature flags (1.9.0, Sprint 52, migration 137; live changes 1.9.9-qa)

Feature flags (B-167 to B-169, `flags/`) switch behaviour; they are not an access control and hold no secrets.

- **What the console sees.** Only flags marked `client` (the default) and not removed, each as the one value it
  evaluates to for the signed-in person (workspace over tenant over plan over platform, with the sticky rollout), in
  the session, `/api/me` and `GET /api/me/flags`. Never the other levels, the rollout, the plan, the owner or flags
  marked server-only. A `data-feature-flag` gate only hides markup: the person can turn a gated element back on in
  their own browser, so a feature behind a flag must check it on the server too (`s.flags.on`), and a flag never
  replaces a permission, a clearance or a policy.
- **No secrets in flags.** Keys, descriptions, owners and values are plain configuration, audited `flag.*` with their
  values, shown to platform and tenant admins and (for `client` flags) to every console. A credential, a token, a
  URL with a credential in it or personal data does not belong in a flag; use the vault (`vault:` references).
- **Dual control.** Definitions, plan values and platform values are for platform admins with a recent sign-in. A live
  flag's (active or deprecated) platform default and platform rollout change only through a proposal a second
  platform admin approves; a planned flag changes at once. Tenant and workspace values are for the tenant's admins,
  for their own tenant, on overridable flags only. Every change is audited.
- **Live changes.** A change publishes `feature.flags` on the bus (every instance drops its cache) and, since
  1.9.9-qa, each instance emits `flags.changed` to the console sockets it holds (`realtime/flags.ts`): to the affected
  tenant's room for a tenant, workspace or subscription change, to every socket for a platform change. The event is
  `{ at }` only, with no key and no value, so a socket learns that something changed, never what; the console then
  fetches `GET /api/me/flags`, evaluated for that person as always. Rooms are the server's (the tenant room from the
  session's principal). Events are coalesced per room for 250 ms, and each console waits a random 50 to 450 ms before
  it fetches, so one change does not make a tenant's consoles ask at the same instant; the one-minute refetch on route
  changes stays as the fallback (a socket that missed an event while disconnected fetches when it reconnects).

## Search index (1.9.0, Sprint 52, migrations 138 and 139)

Messages, posts and comments are sealed at rest, so keyword search runs on a **blind index** (B-170, open decision 2
taken as assumed: no plain text stored; a `tsvector` index for low labels was not built).

- **What is stored.** For every kept word of a sent message, a published post or a published comment, one row of
  `search_postings`: HMAC-SHA-256 of the folded word under the tenant's search key, cut to 128 bits, with the
  document's kind and id, its partition (conversation, group or workspace) and the word's position among the kept
  words. `search_prefixes` maps the hashes of 2-, 3- and 4-character beginnings to the term hashes that start with them
  (one row per prefix and term of the vocabulary, not per document). `search_docs` holds what each document is (ids,
  author, time, label, visibility, length in kept words, whether it has a file or a link). No word, prefix, snippet or
  query is stored anywhere; `server/test/search-index.test.ts` reads every table for its sample words.
- **Keys.** Each tenant has its own search key per version: 32 random bytes sealed with the tenant's data key
  (`search_keys`, associated data `search-key:<tenant>:<version>`). Hashes are not comparable across tenants or key
  versions. A rotation (`POST /api/admin/search/rotate`, `tenant:manage`, audited) indexes everything again under a
  new key while queries use the old one, then deletes the old version's postings, prefixes and key. Offboarding
  destroys the tenant key, which leaves every posting meaningless, and the purge deletes the tables' rows.
- **What it reveals to someone who reads the database without the keys** (a backup, a replica, a database
  administrator): how often each hashed word occurs, in each document and across the tenant (term and document
  frequency); which hashed words occur in the same document and, through positions, next to one another and in which
  order (co-occurrence and word order, enough for bigram statistics); each document's length in kept words; and, from
  `search_docs`, who wrote what when, at which label, with a file or a link. With frequencies like these, the most
  common words of a large tenant can be guessed by frequency analysis against a language's statistics, and documents
  can be compared for likeness, without any key. The prefix table adds the vocabulary's shape: which hashed words share
  their first two to four letters, which narrows those guesses further; a 2-letter prefix splits the vocabulary into a
  few hundred groups, a 4-letter one into small ones. Prefix rows outlive the documents that brought a word in until
  the next rotation or rebuild, so the vocabulary of deleted text stays visible as hashes until then. Stop words are
  not indexed (their frequencies would help such guessing most). Anyone who also holds the tenant key can open the
  sealed text itself, so the index adds nothing for them.
- **What it does not reveal.** No word, phrase or prefix in clear; nothing about another tenant; nothing to a reader
  through the API beyond what they may read: every source is searched as the reader, every result is checked again
  (membership, clearance, state, blocks, mutes, visibility) before its text is opened, and filters apply before
  anything is counted. Queries are not audited and not stored (the console keeps recent searches in the browser),
  except when a person saves one.
- **Saved searches (1.9.9-qa, migration 145).** A saved search's name, query text and filters are content: they are
  sealed together with the tenant key (`saved_searches.sealed`, associated data `saved-search:<tenant>:<user>:<id>`,
  so a row copied to another person or tenant does not open); only the source (`all`, `chats`, `posts`…) and the times
  are plain. They are the person's alone: every read and write is by the session's tenant and user, and another
  person's is not found (404, the same as a missing one). Running one is the same search as typed, as the reader now:
  the source's permission is asked again and every result is checked again, so a saved search never keeps access the
  person lost. Creating, changing and deleting are audited `search.saved.*` with the source and the names of the
  filters, never the name, the query or the filter values; runs are not audited. At most 100 per person. Destroying
  the tenant key at offboarding leaves them unreadable.
- **Links to one message.** `GET /api/search/messages/:id/locate` (`messages:read`) says where a message is, for the
  console's jump to it: its conversation, time, thread and state (sent, deleted, hidden, held), without its text, and
  only when the reader can see it now (member, joined before it, no block, cleared for it). Anything else, including
  an id that never existed, answers the same `unavailable`, so the route tells nobody that a message exists.
- **Writes.** Indexing runs after the write commits, from the domain's integration events and audit entries, and never
  fails it; a failed index write is retried as a job. Nothing is indexed until a tenant admin turns the index on.

## Cloud accounts, regions and residency (1.9.99-final, Sprint 56, migration `146_cloud_accounts`)

- **Scope and tenancy (B-10002).** A tenant-scoped account belongs to the tenant of the session that added it (never
  a body field) and is seen and changed only there; a platform account is changed only by a cloud admin who also
  holds `platform:manage`, so a tenant admin cannot add, change or approve one. A tenant account serves data
  connections and model backends only (open decision 6); `assertRegionAllows` refuses any other use.
- **Dual control.** Adding and removing an account, changing its credential mode, raising a region's ceiling and
  widening a tenant's residency are proposals another cloud admin approves with a recent sign-in; the proposer
  cannot. An added account is `pending` and refused by every placement until then. A platform account's change and
  any `restricted` ceiling (the override of open decision 4) need `platform:manage` to approve. Cloud admin and Cloud
  operator need a second factor.
- **No secret values.** Accounts hold `vault:` references and non-secret parameters (role ARN, client id); a literal
  value where a reference belongs is refused (`not_a_reference`). Readers without `cloud:admin` see reference names
  only. Validation reports and audit entries carry permission names, provider request ids and principals, never a
  token; a provider's error text is scrubbed before it is shown.
- **Placement (B-10008).** Every placement in a cloud region goes through `assertRegionAllows`: the account usable,
  the region on its allow-list, the label at or below the lower of the region's and its zone's ceiling, and
  `confidential` (or an overridden `restricted`) only in the owning tenant's residency. Without migration 146 every
  placement is refused. The decision is `regionAdmits` in `authz/policy.ts`, so `explain` names the region.
- **Validation (B-10007).** Provider calls happen only inside the adapters, through the egress checks; a credential
  that belongs to another provider account fails validation, and a feature with missing permissions is refused by
  `assertFeature` naming them.

## Cloud federation and credentials (1.9.99-final, Sprint 56, migration `147_cloud_federation`)

- **Federation issuer (B-10003 to B-10005).** The clouds trust a separate issuer (`CLOUD_ISSUER_URL`, default
  `PUBLIC_URL/cloud-issuer`), never the console's OIDC issuer, with its own keys (`cloud_issuer_keys`). Its private
  keys are made and used in the signer process or OpenBao transit; only when neither is configured are they sealed
  with the platform data key, and such a key is replaced by a held one as soon as either is configured. A token is
  minted for one exchange: `sub` `cloud-account:<id>`, `aud` `sts.amazonaws.com` or `api://AzureADTokenExchange`,
  `CLOUD_ISSUER_TOKEN_SECONDS` long (300 s), with a `jti`. ES256 always; with `CLOUD_AZURE_SIGNING_ALG=RS256` an
  RSA-2048 key signs for the Azure audience only (open decision 3, to be confirmed against a sandbox tenant).
- **What is public.** Only the discovery document and the JWKS (public members only), written to the publication
  target (S3, Azure Blob static website, DigitalOcean Spaces, R2) or served by the console on `/cloud-issuer/...`
  when the target is `console`; with any other target those two paths answer 404. A new key is published before it
  signs (`next`), signs only once the last successful publication listed it, and a retired key stays published for
  `CLOUD_SESSION_SECONDS` plus the token lifetime plus 15 minutes. The `cloud.issuer.check` job reads the published
  copy back over the issuer URL and compares it key by key; a mismatch or an unreadable copy raises a security notice
  to the platform's cloud admins and `cloud.issuer.mismatch` in the audit chain, once per change.
- **Sessions.** AWS sessions (`AssumeRoleWithWebIdentity`, `CLOUD_SESSION_SECONDS`) and Entra tokens are kept in the
  process's memory only, per account and role or scope, refreshed at two thirds of their life, and dropped on every
  instance (over the bus) when the credential changes or rotates. The roles' trust policies the setup helper renders
  are conditioned on `aud` and `sub`, and the deploy policy on the `exprsn:*` tags. A federated account has no
  long-lived cloud key anywhere.
- **Vaulted credentials (B-10006).** AWS access keys, Azure client secrets, DigitalOcean and Cloudflare tokens and
  publication key pairs are KV secrets in the vault's platform scope (`sys/kv/cloud`), sealed under the platform data
  key, label `restricted`, read and written only by the service `cloud.credentials` (a grant made once). This holds
  for a tenant's own account too, so a tenant admin's broad grant in the tenant's vault never reaches a cloud key.
  `cloud_credentials` holds references; a reference under `vault:cloud/` resolves only for the account it belongs
  to (`cloud/accounts/<id>`, or staged for the account's scope under `cloud/secrets/<scope>/`); any other reference
  resolves as the person who saved the credential, under their vault policy. No route returns a value: values go in,
  references, kinds, last use, rotation state and expiry come out. Audit entries name paths, versions and the last
  four characters of an access key id, never a secret.
- **Rotation.** AWS keys: a new key for the key's own IAM user, checked with `GetCallerIdentity`, written to the
  vault and used at once on every instance; the old key is deleted after `CLOUD_AWS_KEY_OVERLAP_MINUTES`, and every
  `CLOUD_AWS_KEY_ROTATION_DAYS`. Azure client secrets: Graph `addPassword`, checked by buying a token with it, then
  `removePassword` of the old one after the overlap; when Graph refuses (the app may not change its own secrets) the
  admins get notices before it expires. DigitalOcean and Cloudflare tokens: notices `CLOUD_CREDENTIAL_NOTICE_DAYS`
  before the expiry given when they were stored, and a guided replace. A certificate credential's key is made in the
  signer or transit by the CA and signs client assertions there.
- **Egress.** STS, IAM, Entra, Graph and the publication targets are reached through `guardedRequest` under the
  operator's service policy (metadata addresses never), pinned to the checked address, with no redirects.

## Cloud deployments, plans and the journal (1.9.99-final, Sprint 57, migration `148_cloud_journal`)

- **Who.** Reads need `cloud:read`; plans, applies and verifies `cloud:deploy` (Cloud admin, Cloud operator), and a
  deployment on a platform account also `platform:manage`, checked in the service, so a tenant's cloud operator can
  never plan or apply on a platform deployment. The tenant comes from the session. Applying needs a recent sign-in in a
  browser session (`requireRecentAuth`), so an API key cannot apply.
- **Placement first.** A plan checks every region of its graph with `assertRegionAllows` (the deployment's label, use
  `deploy`) and the account's last validation for the deploy feature before any provider call.
- **Reviewed plans only.** Apply takes the plan's hash: a plan changed after review cannot be applied with the old
  hash, an expired one (60 minutes) is refused, and the provider is read again first: anything changed out of band
  makes it `stale` and nothing is applied (a fresh plan is offered). Protected resources are never deleted or replaced
  by an apply (`blocked`) unless the destroy flow passes their approval.
- **One writer.** The deployment's lease admits one apply at a time across instances; a lost lease stops the run.
- **No second copies.** Every step is journalled before its provider call and resumed from the journal; creates use
  the adapters' idempotency (client tokens, PUT by name, lookup by tag or name), so a lost response or a crash never
  leaves an untracked billed resource behind (the orphan sweep, B-10107, covers what escapes).
- **Trail.** Every resource row names the journal step and the audit entry that created it; every audit entry about a
  provider call carries the provider's request id; the journal and the audit details hold ids, tags and states, never
  a credential. Verify reads `/readyz` and dials TLS only through the egress guard (metadata addresses never).

## Cloud drift, destroy, orphans and limits (1.9.99-final, Sprint 57, migration `149_cloud_lifecycle`)

- **Who.** Reading findings, destroys and orphans needs `cloud:read`; drift decisions, sweeps and adoptions
  `cloud:deploy`; destroy and rollback `cloud:deploy` with a recent sign-in in a browser session, so an API key can
  never destroy; approving or refusing the deletion of a protected resource and deleting an orphan `cloud:admin`, with a
  recent sign-in to approve or delete. A platform deployment also needs `platform:manage` for every change, checked in
  the services. A revert applied at once needs a recent sign-in too.
- **Dual control for protected resources.** A destroy never deletes a protected resource (the `protect` flag, every
  database) on the requester's word: a second cloud admin, not the person who asked, approves each one, and its final
  snapshot must exist at the provider before the round that deletes it is planned. Where the adapter has no snapshot
  for the type, approving is refused, so such a resource is deleted only after its protection is removed from the
  desired graph through a reviewed plan. Refusing ends the destroy.
- **Reviewed plans only.** Revert, destroy rounds and rollback all go through `s.cloud.plans` (placement checks,
  the out-of-band check, the lease, the journal); nothing in this work calls a provider's delete outside the apply
  worker except an orphan delete, which is journalled under the deployment and refused for databases.
- **Acting for a person.** Destroy rounds and the automatic rollback run as the person who last acted (the requester,
  each approver, the person who applied), loaded fresh with their current roles; an account that is no longer active
  stops the destroy.
- **Limits and breaker.** Per-API-class buckets on the shared counter store keep the clouds' own limits from being
  reached, so a burst is slowed locally instead of refused remotely; the breaker stops calling a provider account that
  keeps failing. Metrics carry no account id or tenant data.
- **Notices.** Drift notices go to the deployment's creator and the tenant's cloud admins (a platform deployment's:
  those who also hold `platform:manage`); approval notices to the other cloud admins. They name keys and fields, never
  values of secrets (desired and observed props are the providers' resource fields).

## Cloud KMS and Azure Blob for deployed installs (1.9.99-final, Sprint 58, B-10208, no migration)

- **Keys stay in the cloud KMS.** With `KMS_PROVIDER=aws-kms` each tenant's key-encryption key is a symmetric AWS KMS
  key (`alias/<prefix>tenant-<id>`, automatic yearly rotation); with `azure-keyvault` an RSA-3072 Key Vault key
  (RSA-HSM with `KMS_AZURE_HSM`). The server sends only a tenant's 32-byte data keys to be wrapped and unwrapped; the
  key material never leaves the KMS. The associated data is bound into every wrap (the AWS encryption context; its
  SHA-256 inside the RSA-OAEP plaintext for Key Vault, checked after unwrap), and AWS Decrypt names the expected key, so
  a wrapped key moved to another tenant or version does not open.
- **Signatures instead of HMACs.** Checkpoints, backup manifests, image provenance, model cards, bundles and chat
  artifact links are signed in the KMS with an ES256 key per signing name (AWS `ECC_NIST_P256`, Key Vault EC P-256),
  over the SHA-256 of the name and the data, and verified locally with the public key. A signature names the key (AWS
  key id) or key version (Key Vault) that made it; verification fetches that public key from the KMS, so only keys the
  install's own identity can read count, and a rotated signing key keeps every older signature verifiable.
- **The install's identity, never the metadata service.** The KMS and Blob credentials come from the environment,
  read explicitly: an EKS web identity token (STS `AssumeRoleWithWebIdentity`, one-hour sessions), an AKS workload
  identity token (the Entra client assertion), or vaulted secrets given only as files. Every call goes through the
  cloud transport and the egress guard (metadata addresses refused, provider hosts or `SERVICE_ALLOWED_HOSTS` only,
  the connection pinned to the checked address); no SDK credential chain runs. Production refuses
  `KMS_AWS_SECRET_ACCESS_KEY`, `AZURE_IDENTITY_CLIENT_SECRET` and `BLOB_AZURE_ACCOUNT_KEY` inline (open decision 11),
  and with `REQUIRE_BACKEND_TLS` a plain-http KMS or Blob endpoint.
- **Crypto-shredding.** Offboarding schedules the tenant's AWS keys for deletion (`KMS_AWS_DELETION_DAYS`, 7 to 30)
  and deletes their aliases at once, so nothing opens them through the server again; Key Vault keys are deleted and
  purged when the identity holds the purge permission.
- **Azure Blob.** Objects are block blobs; a stream is staged in 8 MiB blocks and committed in one block list, so a
  reader never sees half an object; ranged reads after the first are conditional on its ETag, so a replaced object
  fails a read instead of mixing versions. Blob contents are sealed by the services before they are stored, as with
  the other stores.

## Managed databases (1.9.99-final, Sprint 59, B-10301, B-10303, B-10307, migration `153_cloud_databases`)

- **Private only.** A `database` resource must have `publicAccess: false` (the planner's `publicDataProblems` and the
  adapters both refuse otherwise): RDS and Aurora not publicly accessible in a DB subnet group of the data subnets
  behind the data security group; Azure with public network access off and a private endpoint in the data subnet;
  DigitalOcean in the data VPC with trusted sources taken from the data zone's firewall (never `0.0.0.0/0`), else the
  VPC's range. DigitalOcean keeps a public host name; its firewall refuses it.
- **No admin password at rest.** RDS manages the master password in Secrets Manager unless a `vault:` reference is
  named, whose value goes straight to the provider; Azure gets the reference's value or a random one nobody keeps;
  DigitalOcean's answer with the password is dropped. None is in props, observed state, handles, the journal, audit or
  errors (the tests check the fakes' records and the observed state).
- **Deletion needs the final snapshot, on every path.** Deletion protection is on by default (RDS `DeletionProtection`,
  an Azure `CanNotDelete` lock, a DigitalOcean tag). The planner blocks a delete, a replace or turning protection off;
  only destroy deletes, after dual control and the final snapshot; and each adapter refuses the delete itself without
  a final snapshot from the last 24 hours (`final_snapshot_required`). Final snapshots are never deleted by
  Exprsn-AI.
- **Restores make a new instance**, never overwrite the source, and the new database is protected. A snapshot or
  restore asked for over the API needs `cloud:deploy` and a recent sign-in.

## The install's own database and caches (1.9.99-final, Sprint 59, B-10302, B-10305, no migration)

- **No secret in a record.** A database move keeps where its target URL comes from (a file, a `vault:` reference the
  asker can read, a deployment), the target's host, port and database name, and the CA file's path; the URL itself
  lives in memory for the run only. Driver messages are stripped of passwords before they are recorded
  (`redact`). The switch writes the URL file atomically with mode 0600 and keeps the previous URL beside it, 0600.
  A provisioned data tier's database password, cache token and URLs live in the platform scope of the vault
  (`cloud/deployments/<id>/data`, `restricted`); they reach the provider through the secret broker and the app as
  files only (a Kubernetes Secret file, a systemd credential, a Container Apps secret file).
- **TLS verified against the provider's CA.** The move connects with `sslmode=verify-full` and `sslrootcert` (the
  host name checked against the certificate) and refuses a target whose connection is not encrypted (`pg_stat_ssl`);
  `--insecure-no-tls` exists for local rehearsals and is not reachable from the console. CA bundles are checked to
  be PEM CA certificates (at most 50, 512 KiB) before they are used or stored.
- **Dual control from the console.** Asking, approving, rolling back and finishing need `cloud:admin` and
  `platform:manage` and a recent sign-in; the approval is never the asker's. The CLI is the operator on the host
  (the same trust as `backup:restore`) and has none.
- **The read-only window.** While a move holds it, every instance answers changes with 503 and its job queue claims
  nothing; the move checks afterwards that the source took no writes (row counts against the backup's manifest) and
  starts over with a new backup when it did, so nothing written during the window is lost by the switch. Audit
  entries made during the window are held in the move's record and appended when it closes, so the old chain is not
  forked.
- **Caches that keep jobs.** A cache that evicts or shards is refused as `REDIS_URL` by the planner and when it is
  wired, and `/readyz` reports one in use; ElastiCache gets an AUTH token and in-transit encryption, Azure caches the
  non-TLS port off and public network access off, DigitalOcean Valkey stays in the VPC.

## The cloud plane: threat model, metadata endpoints and least privilege (1.9.99-final, Sprint 59, B-10705, no migration)

### Threat model

What the cloud plane holds: per-account credentials (federated one-hour sessions bought with a token from the
install's own issuer, or vaulted keys and tokens), the power to create, change and delete billed resources in the
operators' cloud accounts, and the resource graph and journal that say what exists. What an attacker wants: a cloud
credential (to act in the account beyond Exprsn-AI's reach), a resource Exprsn-AI was never meant to touch, or spend.

| Threat | How it is met |
| --- | --- |
| **Server-side request forgery to an instance metadata service** (a workflow HTTP step, an MCP server, a webhook, an HTTP tool, a crawl, a REST connection pointed at `169.254.169.254` or a name that resolves to it) steals the machine's, the task's or the pod's role credentials | Every egress check refuses the metadata names and addresses (below), before any operator or tenant allow-list is read, by name before DNS and by address at connect time; Exprsn-AI itself never reads a metadata service (its own cloud identity comes from the environment, `platform/cloud-identity.ts`); IMDSv2 with hop limit 1 on everything it builds, so a container or pod cannot reach the node's credentials even if something did |
| **Confused deputy**: one tenant's request makes Exprsn-AI act in another tenant's or the platform's account | Accounts are platform-wide or bound to one tenant, checked in the services on every route and job (`cloud/accounts.ts`); AWS trust policies are conditioned on `aud` and on `sub` = `cloud-account:<id>`, so a role trusts exactly one Exprsn-AI account; every apply runs as the person who asked, loaded fresh |
| **Credential theft from Exprsn-AI** (database, backups, logs) | No long-lived AWS key exists for a federated account; vaulted secrets are `vault:` references sealed under B-17's policies, never returned by a route, masked in diagnostics; sessions are one hour and cached in memory only; the credential-compromise runbook (B-10704) cuts the trust or revokes the token |
| **An over-privileged credential**: a compromised instance does anything in the account | The generated policies list exactly what the features call (below): creates only with `exprsn:managed=true` and the account's `exprsn:account` tag, changes and deletes only on resources carrying them, no `exprsn:*` tag removable, `iam:PassRole` only for `exprsn-<account>-*` roles and only to EKS, ECS and EC2; separate read, deploy and billing roles when the operator wants them; Azure Contributor only on managed resource groups, or the generated custom role in its place |
| **Cross-tenant data in the cloud**: a label's data in a region or edge it may not reach | Region ceilings and residency rules in `authz/policy.ts` (B-10008), unchanged |
| **Leaked or orphaned resources and runaway spend** | Tags on everything, the journal, the orphan sweep, budgets with the hard stop, and since this sprint the cloud alerts (`exprsn-ai-cloud.rules.yml`: failing steps, stuck operations, open drift, budget forecast and hard stop, idle GPU nodes) |
| **A forged or stolen GPU node** (Sprint 60, B-10401) joins a pool and receives prompts, or a node is impersonated to the gateway | A node joins only with a single-use enrolment token (only its hash kept, 30 minutes, spent in one conditional update, bound to the node's name and private address on node groups) that never enters the graph or the journal; its certificate names exactly its address inside the deployment's network; the gateway connects with the pool's client certificate and pins the node's certificate; the node's proxy accepts only the gateway's certificate; every refusal is audited. Its pulls are limited to the model mirror by the bootstrap and its egress guard |
| **A provider endpoint that is not the provider** (DNS answer pointing inward) | Provider hosts only (`CLOUD_PROVIDER_HOSTS`) or what `SERVICE_ALLOWED_HOSTS` names, internal addresses only when named, the connection pinned to the checked address; tests cannot reach real clouds (`EXPRSN_TESTS_OFFLINE`) |

### Metadata endpoints, refused by every egress check

`platform/metadata.ts` holds the set: `169.254.169.254` (AWS, Azure, GCP, DigitalOcean, Oracle, OpenStack),
`169.254.169.253` (AWS VPC DNS), `169.254.170.2` (ECS task metadata and task-role credentials), `169.254.170.23` (EKS
Pod Identity), `169.254.0.23` (Tencent), `100.100.100.200` (Alibaba), `192.0.0.192` (Oracle, legacy), `168.63.129.16`
(Azure WireServer), `fd00:ec2::254`, `fd00:ec2::253`, `fd00:ec2::23` (AWS over IPv6), `fd20:ce::254` (GCP over IPv6);
and the names `metadata.google.internal` (and everything under it), `metadata.goog`, `metadata`, `instance-data`,
`instance-data.ec2.internal`, `metadata.tencentyun.com`. An IPv6 spelling of an IPv4 one is the same address
(IPv4-mapped in dotted or hex form, IPv4-compatible, SIIT, the NAT64 prefix `64:ff9b::/96`, 6to4); decimal, octal and
hex IPv4 literals are normalised by the URL parser before the check. The paths:

| Path | Where the refusal sits |
| --- | --- |
| Workflow HTTP steps | `workflows/http.ts` `internalRequest`: the name, then every resolved address, before `WORKFLOW_HTTP_HOSTS` or the tenant's list (`fd00:ec2::254` is in `fc00::/7` and was "internal" before this sprint) |
| MCP servers, webhooks, connection drivers (PostgreSQL, MySQL, MongoDB, Redis, SQL Server, Snowflake, BigQuery, InfluxDB, Prometheus, RabbitMQ), user-store directories, vault lease engines, app subscriptions, ops pushes and mirrors, dns-01 providers, federation upstreams | `mcp/hosts.ts`: `addressProblem`, `checkHost`/`checkUrl` (name before DNS) and `guardedAgent`'s lookup (every address dialled) |
| HTTP tools, the net built-ins (`http_fetch`, `http_request`, `http_download`), file imports, REST/GraphQL/SOAP connections, API-key providers, push providers, cloud adapters, verify, cloud directories, platform imports | `platform/egress.ts` `guardedRequest` and `guardedHttp2Connect` refuse metadata whatever the caller's `check` allows; `toolAddressProblem`, `serviceAddressProblem`, `cloudAddressProblem`, `isPublicAddress` refuse it too |
| Pool instances, zone endpoints, image backends, the training and classifier workers, moderation providers, the import fetcher, DID and PDS fetches, firehoses, SIEM destinations, ACME http-01 validation, the knowledge crawl and S3 sources | `serviceAgent`/`serviceLookup`, `checkServiceHost`, `checkServiceUrl` and `literalProblem` (now also by name) |
| Operator-set URLs that had no check: OpenBao (transit and dynamic credentials), the S3 blob endpoint, the Stripe API base, the HIBP range API (server and CLI), the legacy SIEM URL, the ACME client's directory, the image safety classifier, the in-cluster Kubernetes API, the OTLP collector | `metadataSafeFetch`, `metadataSafeAgent` and `assertNotMetadataUrl` in `platform/egress.ts`: only metadata is refused; loopback and private addresses keep working |
| WHOIS referrals (`platform/netdiag.ts`) | a WHOIS server that resolves only to metadata is refused |

Tests: `server/test/metadata-refusal.test.ts` (every address and name on every path above, allow-listed by
`SERVICE_ALLOWED_HOSTS`, `MCP_ALLOWED_HOSTS`, `WEBHOOK_ALLOWED_HOSTS`, `WORKFLOW_HTTP_HOSTS`, `KNOWLEDGE_ALLOWED_HOSTS`
and the tenant's list, plus a normal name resolving to each address through the DNS stand-in).

### IMDSv2 on everything Exprsn-AI builds

EC2 instances (app and GPU VMs): `HttpTokens: required`, hop limit 1, instance tags off, put back on update; the
planner refuses any VM spec with IMDSv1 or a hop limit above 1. EKS node groups (since this sprint): each is made from
its own launch template (`<node group>-imds`) holding only those metadata options, deleted with the group, so a pod
off the host network cannot reach the node's role. With hop limit 1, the AWS Load Balancer Controller needs its region
and VPC id given (`--aws-region`, `--aws-vpc-id`) and its credentials from IRSA or Pod Identity. ECS runs on Fargate,
which has no instance metadata service (only the task's own endpoint, which Exprsn-AI's egress refuses). Azure VMs and
AKS nodes have no token mode (IMDS answers only non-proxied requests with `Metadata: true`), and DigitalOcean droplets
have none either: there the egress refusal is the control. Node groups made before Sprint 59 keep their AMI's defaults
until replaced.

### Least privilege, generated and tested

`cloud/setup.ts` derives every action it renders from the per-feature lists in `cloud/providers/capabilities.ts`
(the lists the permission check simulates): read (the identity check's `sts:GetCallerIdentity` and
`iam:SimulatePrincipalPolicy`, and every read-only action), the model calls, deploy (describes; creates conditioned on
the request's `exprsn:*` tags; changes on the resource's; Route 53 record changes on hosted zones, an imported
certificate and the cluster load balancer's listener, which carry no Exprsn-AI tags; `iam:PassRole` for the account's
own roles; a deny on removing `exprsn:*` tags), billing. No wildcard action. Azure gets a custom role with the deploy,
data and compute actions, assignable only at the managed resource group, as the alternative to Contributor.
`server/test/cloud-least-privilege.test.ts` reads the AWS adapters' source for every API call they make (SDK commands,
JSON targets, query actions, EKS REST paths, Cost Explorer and the price list), checks each is in a feature's list,
and checks that the generated documents allow exactly the union of the lists.

## Cloud models: data residency and label ceilings (1.9.99-final, Sprint 60, B-10501, B-10504, migration `159_cloud_models`)

- **Where prompts go.** A Bedrock model server (`kind: bedrock`) sends prompts, tool results and embeddings only to
  its account's regional Bedrock endpoints, through the cloud transport: the egress guard (provider hosts or hosts the
  operator names; never a metadata address), the shared rate limiter and the breaker. Requests are signed with the
  account's `read` credential (a federated session of at most `CLOUD_SESSION_SECONDS`, or the vaulted key), never a
  key in the instance row; no token is accepted for such an instance.
- **Residency.** The pool a Bedrock instance joins may not have a label ceiling above its region's
  (`assertRegionAllows` when it is registered). Before every model call the server checks each region the model may
  route to (an inference profile's regions, from its models' ARNs) against the account's allow-list, ceiling and the
  tenant's residency for the model's label; a global profile is always refused, and a cross-region profile is refused
  when any of its regions is off the allow-list. The decision is kept for thirty seconds per model.
- **Label ceilings (open decision 5).** The catalogue import caps a cloud model's ceiling at `internal`, or at
  `confidential` once the account's data terms are attested (B-10507), and never above the lowest ceiling of its
  routing regions; never `restricted`. Approving a cloud model, or raising its label, above that ceiling is refused
  (`403` step `zone`), and so is approval while a routing region no longer admits the label. Drafts are never
  approved or published by the import; dual control applies as for any model (B-4304).
- **Terms.** The provider's terms are recorded as the draft's licence and in the entry, with the access state at
  import. The data terms are not yet attested per account (B-10507): until then nothing above `internal` reaches a
  cloud model.
- **Framing.** ConverseStream's event-stream frames are checked (prelude and message CRC32, lengths, a 16 MiB frame
  limit, the transport's 16 MB answer cap); a malformed or truncated stream fails the turn and is never shown in part
  as complete.

## Cloud Chat Completions endpoints: Azure OpenAI, DigitalOcean GenAI, Workers AI (1.9.99-final, Sprint 60, B-10502, B-10503, B-10509, migration `160_cloud_model_servers`)

- **Where data goes.** A flavoured `kind: openai` instance sends prompts, tool results and embeddings to its
  provider: Azure OpenAI to the resource's endpoint (its region is the resource's location); DigitalOcean GenAI to
  `inference.do-ai.run` and an agent tool's prompt to that agent's endpoint (`*.agents.do-ai.run`), both run by
  DigitalOcean; Workers AI to `api.cloudflare.com`, which runs the model on Cloudflare's network. **Cloudflare's edge
  terminates TLS and sees the decrypted prompt and answer**, as open decision 5 notes for the front door; Workers AI
  instances therefore sit in a pool whose ceiling the `global` region admits (`internal` until raised under dual
  control). Every pool's ceiling is checked against the account's region when the instance is registered.
- **Credentials.** Azure: an Entra token for the Cognitive Services scope bought with the account's credential
  (federated or vaulted, never stored on the instance) per request through the credential cache, or the resource's
  API key in the vault (`api-key` header, never returned). DigitalOcean: a model access key in the vault; an agent's
  access key only as a `vault:` reference the publisher can read, resolved at call time as the entry's owner. Workers
  AI: the account's scoped token ("Workers AI Read"). Raw keys given to the instance route go to the vault and are
  shown nowhere.
- **Guardrails.** Exprsn-AI's checkpoints run as for every model: the provider's content filter is an extra layer.
  An Azure block is recorded as a guardrail decision with its categories (the inspected text sealed) and is final for
  the turn: the fallback chain does not send a blocked prompt to another model. A DigitalOcean agent is a registry
  tool: the `tool-call` checkpoint, the ceiling, rate limit and approval rules apply before it is called, and its
  answer passes the `context` and `untrusted-content` checkpoints as outside content.
- **Egress and tests.** The new provider hosts are in `CLOUD_PROVIDER_HOSTS`; the connect-time lookup the Chat
  Completions client uses (`serviceLookup`) also refuses them under `EXPRSN_TESTS_OFFLINE`, so no test reaches a real
  cloud. ARM and DigitalOcean and Cloudflare API calls go through the cloud transport (egress guard, rate limiter,
  breaker); the inference calls themselves go through the gateway's own egress policy, not the cloud transport's rate
  limiter.

## Cloud GPU autoscale and spot interruptions (1.9.99-final, Sprint 60, B-10402, B-10403, B-10605, migration `158_cloud_autoscale`)

- **Who scales.** A person scales a node group from Pools with `pools:manage` and `cloud:deploy` or `cloud:admin`
  (`PUT /api/admin/pools/:id/autoscale`, `POST /api/admin/pools/:id/scale`); the autoscaler acts as the service
  `autoscale`. Every size change is audited (`cloud.pool.scaled`, `.scale.refused`, `.scale.failed`,
  `.capacity.fallback`, `.autoscale.set`) with the provider's request id, and journaled as a node group `update`.
- **Cost.** A scale-up counts as adding cost (open decision 10) and is refused past the budget's hard stop without an
  override, from Pools, from the autoscaler and for a cold start; a scale-down is always allowed, so a runaway pool can
  always be stopped.
- **The node channel.** `POST /cloud/v1/nodes/interruptions` takes no session: the node presents its Exprsn-AI CA
  certificate, matched by SHA-256 fingerprint to a valid, unexpired `pki_certificates` row issued at enrolment
  (`cloud_gpu_enrolments.certificate_id` → the instance). A revoked or unknown certificate is refused (`401`). The
  certificate is read from this server's TLS socket, or from `PKI_CLIENT_CERT_HEADER` only when the request came
  through a proxy that `TRUST_PROXY` trusts and it says the certificate verified. A node can only drain its own
  instance, and only when the enrolment's link is the instance's pool (the gateway's client certificate, or one
  issued to another pool, is refused). The node certificate carries serverAuth and clientAuth (the server profile's
  `clientAuth` policy flag, set on `gpu-nodes-<deployment>`). The body is 4 kB at most, the same notice is recorded
  once, and each address may post 60 notices a minute (`cloud-node-interruptions`); the public enrolment
  (`POST /cloud/gpu/v1/enrol`) is limited to 30 attempts per address in ten minutes (`cloud-gpu-enrol`).
- **Drains.** A notice moves leases off the node 20 s before the reclaim: their calls are aborted, and a chat answer
  resumes from its stored (already screened) text on another instance through `ChatService.continue`, as the user
  would; the output check runs on the whole answer again.
- **Offline tests.** The suites scale an in-memory provider; nothing reaches a cloud.

## The Cloudflare front door: what Cloudflare sees, client addresses, Access (1.9.99-final, Sprint 61, B-10901 to B-10904, migration `161_cloud_edge`)

- **Cloudflare sees decrypted traffic.** Behind the front door TLS ends at Cloudflare's edge (Full strict to the
  origin re-encrypts, a tunnel carries it inside its own TLS): every request and answer, prompts, answers, files and
  session cookies included, passes Cloudflare in the clear. A deployment behind it is therefore capped at
  `confidential` (open decision 5): a `restricted` deployment is refused a Cloudflare front door, and the deployment
  spec's `cloudflare` front door refuses a label above `confidential`. The WAF's OWASP set is skipped for model prompts,
  so prompts are inspected by the Cloudflare Managed Ruleset only. Caching is off for `/api/`, `/v1/`, `/socket.io/`
  and streams.
- **Client addresses.** `CF-Connecting-IP` is believed only with `cloudflare` in `TRUST_PROXY`, and only from a
  Cloudflare egress address (the shipped, dated list or `CLOUDFLARE_IP_RANGES`) or the tunnel connector as the
  socket's own peer (`CLOUDFLARE_TUNNEL_PEERS`); from anyone else it is dropped from the request. `TRUST_PROXY=true`
  with `cloudflare` is refused at start. An install without `cloudflare` reads no Cloudflare header. A public origin
  should still accept connections only from Cloudflare's ranges at its firewall, or a client could reach it directly
  (with no edge rules and its own address); a tunnel origin listens on loopback or the cluster only.
- **The tunnel token** is read once into the vault (platform scope, `restricted`) and leaves it only through
  `exprsn-ai cloud:tunnel-token`, into a new 0600 file (audited); no route, log or audit entry carries it. Whoever
  holds it can run a connector for the name: rotate it in Cloudflare and apply again if a file leaks.
- **Cloudflare Access** is an extra layer: a valid `Cf-Access-Jwt-Assertion` never signs anyone in or stands for a
  session, and paths Access does not protect (`/v1`, OIDC, SAML, `/.well-known/`, the ACME challenge, webhooks,
  public share links and the other machine paths) are never asked for it. With Exprsn-AI's own OIDC provider as
  Access's identity provider only the admin console is covered (a host-wide application would put the sign-in page
  behind itself). The client secret given for it is checked and passed to Cloudflare, never stored.
- **Offline tests.** The suites run against `fake-cloudflare.ts`; the ranges are data; nothing reaches Cloudflare.

## On-prem front doors and the change trail (1.9.99-final, Sprint 62, B-10209, B-10703, migration `165_cloud_change_trail`, not registered yet)

- **On-prem installs behind the front door.** Registering one (`kind: onprem`) calls no cloud and plans no compute;
  it needs `cloud:deploy`, `platform:manage` and `cloud:admin` (it creates the front door) with a recent sign-in, and
  is held to the front door's cap: a label above `confidential` is refused (Cloudflare sees decrypted traffic). The
  tunnel's origin is the install's own address (loopback, the Compose network or the cluster's service), so the app
  publishes no port; the token stays in the vault as for any front door. Drift on it reads only the tunnel and the
  record through the Cloudflare adapter; a token scoped to the front door lists no R2 or Containers, and drift skips
  those lists instead of failing.
- **The change trail reads who changed what.** Principals (IAM ARNs, Entra callers, Cloudflare users' e-mail
  addresses) and source addresses from CloudTrail, the Activity Log and Cloudflare's audit logs are stored per open
  drift finding (`cloud_change_trail`) and answered to `cloud:read` on the deployment's drift; they are the provider's
  own records, kept as given (at most five events per finding). Lookups are read-only, bounded (open findings only,
  24 hours before each first sighting, ten per run, four per finding) and go through the transport's egress guard,
  limiter and breaker. The new permissions are read-only: `cloudtrail:LookupEvents` (AWS read tier),
  `Microsoft.Insights/eventtypes/values/read` (Azure; Reader holds it), Cloudflare "Account Settings Read" (which also
  lets the token read the account's other settings). A change made with Exprsn-AI's own credential is marked
  `byExprsn`, never hidden. A refused or failed lookup leaves the finding as it was, with the error.
- **Offline tests.** `cloud-onprem.test.ts` and `cloud-change-trail.test.ts` run against the AWS, Azure and Cloudflare
  fakes (CloudTrail, the Activity Log and the audit logs included); nothing reaches a cloud.

## Cloudflare app tier, R2, D1 and AI Gateway (1.9.99-final, Sprint 61, B-10905 to B-10908, no migration)

- **The app tier on Cloudflare** sees everything the app does: the container and its Worker run on Cloudflare, with
  the deployment's secrets as Worker secrets (read from the vault at create time and handed to Cloudflare's secret
  store only, never in props, the journal, observed state or an error). `DATA_KEY`, `SIGNER_TOKEN` and the cloud
  credentials never go there: the planner refuses them among a Worker's settings or secrets, so the key-encryption
  key stays in OpenBao transit. The static assets are only scripts, styles, images and fonts; every HTML page comes
  from the app with its CSP. The front door's `confidential` cap (open decision 5) applies.
- **Hyperdrive** holds the database's password (and, through a tunnel, an Access service token) on Cloudflare; they
  go there from the vault at create time and are never read back.
- **R2 jurisdictions** keep a bucket's data in the EU or FedRAMP boundary; the jurisdiction follows the bucket's
  region (`r2-eu`, `r2-fedramp`), which the account's allow-list, ceilings and residency rules check.
- **D1 has no read-only role**: the SQLite classifier is what keeps a D1 connection read-only (writes, `PRAGMA`,
  `ATTACH`, schema changes and transactions refused before anything is sent; file and schema functions denied), and
  the driver refuses to send anything not classified as a read. Scope the API token to D1 on one account.
- **AI Gateway** sees prompts and answers in the clear. Above `internal` it is told not to log or cache
  (`cf-aig-collect-log: false`, `cf-aig-skip-cache: true`) unless an administrator turns that on for `confidential`;
  `restricted` is never logged or cached; calls outside a lease count as above `internal`. Exprsn-AI never asks the
  gateway for a fallback and refuses an answer from one, so a gateway-side route cannot pick a model the profile does
  not allow.
- **Offline tests.** The suites run against `fake-cloudflare.ts` (with `fake-cloudflare-app.ts` and `fake-d1.ts`),
  `fake-ai-gateway.ts` and the S3 fake; `gateway.ai.cloudflare.com` and `*.workers.dev` are refused offline, and the S3
  store's requests go through the offline guard too.

## Cloud model prices, provider guardrails and residency (1.9.99-final, Sprint 61, B-10505 to B-10508, migration `163_cloud_model_prices`)

- **Residency by the request's label.** Every chat and embedding call on a cloud model server is checked before it
  leaves, with the label of the conversation or data it serves (not the model's): a cross-region model (a Bedrock
  inference profile, an Azure data-zone deployment) and a global one (a Bedrock `global.` profile, an Azure global
  deployment, DigitalOcean's serverless endpoint, Workers AI on Cloudflare's edge) serve nothing above `internal`;
  the request must be within the entry's ceiling and every region the entry may run in must be on the account's
  allow-list and admit the label, residency included. A `confidential` conversation is never routed to a global or
  cross-region inference profile, whatever label the model carries. Refusals are `403` step `zone` and the turn
  fails before any byte reaches the provider.
- **Egress zone.** Once zones are defined, cloud model calls leave only from pools in a zone whose egress reaches
  outside; a pool in a closed zone is refused. The call still goes through the egress guard (provider hosts only,
  metadata addresses always refused).
- **Attestations under dual control (open decision 5).** A cloud entry's ceiling rises above `internal` only through
  an attestation of the account's data terms (no training on prompts and outputs, retention, abuse monitoring, the
  document), stated by one cloud admin and approved by another, for a regional entry only; never above
  `confidential`, never above its regions' ceilings. Revoking it lowers the ceiling and the model's label at once. A
  listing's own claim of attested terms raises nothing.
- **Provider guardrails stay an extra layer.** A Bedrock Guardrail's interventions are recorded as guardrail
  decisions (findings per policy, never the matched text; the inspected text sealed as for every decision) and end
  the turn; Exprsn-AI's `user-input` and `model-output` checkpoints run before and after whatever it decides, and
  turning it off or removing it touches no Exprsn-AI rule. The guardrail version is confirmed with GetGuardrail
  before it is saved, so a mistyped id is refused rather than silently unguarded.
- **Prices are data, never authority.** Prices only fill `cost_micros`; they decide nothing. An unverified price-sheet
  entry is shown and never used to price a record; API prices are fetched only when an admin asks, through the cloud
  transport (egress guard, rate limiter), and never at metering. Metering never fails because of pricing.

## The release security review of the cloud epic (1.9.99-final, Sprint 62, B-10803, B-10804, migration `167_cloud_sandbox_flag`, not registered yet)

What was reviewed: the ASVS delta of the epic ([asvs.md](asvs.md#the-cloud-epic-1999-final-b-10803)), the cloud
plane's threat model above (confused deputy, a federation `sub` reused, credential theft from vaulted secrets, the
session cache and logs, metadata endpoints, cross-tenant accounts, the GPU node enrolment and mTLS path, the Cloudflare
edge's header trust, Access JWT and tunnel token, cloud model data residency, AI Gateway caching and logging, billing
data), every generated IAM policy, the Azure custom role and the Cloudflare and DigitalOcean token scopes
(`cloud/setup.ts`, `cloud/providers/capabilities.ts`), and each credential path. Each finding fixed here has a test
that failed before its fix (`server/test/cloud-security-review.test.ts`, and new cases in `cloud-gpu-pools.test.ts`
and `cloud-spot.test.ts`). The real-account checks (the IAM conditions as AWS evaluates them, the Azure role, the
token scopes) wait for the sandbox accounts (B-10804, open decision 18).

### Fixed

| Severity | Where | Scenario | Fix |
| --- | --- | --- | --- |
| High | `cloud/setup.ts` (`ExprsnTagOnCreate`) | `ec2:CreateTags` and the other tagging actions were allowed on `*` with only the request's tags, so a stolen deploy session could tag any VPC, instance or security group in the AWS account as `exprsn:managed` for the account, and then `ExprsnChangeOwn` let it change or delete it | EC2 tagging only at create time (`ec2:CreateAction` names the creating calls), ECS likewise (`ecs:CreateAction`); re-tagging (and `s3:PutBucketTagging`) only on resources that already carry the account's tags, with the tags in the request (`ExprsnRetagOwn`) |
| High | `config/index.ts` (`CLOUDFLARE_TUNNEL_PEERS`), `http/client-address.ts` `edgeOf` | The default `loopback` counted any local proxy (nginx on loopback in front of a public origin) as the tunnel connector, so any client could set `CF-Connecting-IP` and become `req.ip` for the throttles, the enrolment and node limits and audit | No default peer: the connector is named (the rendered systemd, Compose and Helm settings already name it) |
| Medium | `http/cloudflare-access.ts` `accessProtects`, `cloud/edge-waf.ts` (`exprsn-admin-allow`) | Express routes paths case-insensitively: `/API/Admin/users` reached the admin routes while the server's Access check and the WAF's admin allow-list compared case-sensitively and let it through | Paths compared in lower case; the WAF rule uses `lower(http.request.uri.path)` |
| Medium | `cloud/credentials.ts` `forget`, `cloud/accounts.ts` reject and withdraw | Removing an account left the secrets its references pointed at under `cloud/secrets/<scope>/` (where `POST /admin/cloud/secrets` stages them, and where replace and rotation keep writing), reusable by naming the path in a new account; a refused or withdrawn add removed nothing | `forget` removes the staged paths no other account names; refused and withdrawn adds forget their secrets, state and caches |
| Medium | `cloud/accounts.ts` (credential change, approved `account.credential`, disable) | A changed or swapped credential, or a disabled account, kept its cached AWS sessions and Entra tokens on every instance until their refresh (up to about 40 minutes) | Every instance drops them over the bus (`changed`) |
| Medium | `routes/admin/gateway.ts` (Bedrock and cloud Chat Completions instances) | Pools serve every tenant: tenant B's model admin could back a shared pool with B's own cloud account, and tenant A's prompts would reach (and could be logged in) B's account | A tenant-scoped account never backs a pool instance (403) |
| Medium | `cloud/gpu-enrol.ts` `enrol` | A token bound to no node (minted by an admin) could enrol under another node's instance name and replace its URL and certificate pin, redirecting that node's traffic | An unbound token cannot take over an instance enrolled at another address |
| Medium | `cloud/autoscale.ts` `interruption` | The node chooses the event id, so one node could post notices with new ids and push its pool to `max` (and spot pools to on demand) | While a reclaim notice for the instance is open, another is the same event |
| Medium | `cloud/setup.ts` (read and deploy tiers) | `ssm:GetParameters` on `*` let the read credential (also used for Bedrock) read every SSM parameter, SecureStrings under the default key included | Only `arn:aws:ssm:*::parameter/aws/service/*` (the public AMI parameters) |
| Medium | `cloud/model-residency.ts` `instanceScope` | An Azure OpenAI model with no catalogue entry of its own was treated as regional, so a GlobalStandard or DataZone deployment served `confidential`; a Bedrock application-inference-profile ARN likewise | Without its own entry, Azure and any ARN that is not a foundation model count as cross-region (nothing above `internal`) |
| Medium | `cloud/ai-gateway.ts` `check` | AI Gateway in front of a regional Bedrock or Azure instance sent prompts through Cloudflare's edge in the clear whatever the pool's ceiling, while Workers AI is held to the Cloudflare region's ceiling | The pool's ceiling must be one the Cloudflare account's region admits (raised only under dual control); a tenant's Cloudflare account is refused |
| Low | `cloud/gpu-enrol.ts` `enrol` | The token was spent before its node and address bindings were checked, so any pod that can read the enrolment Secret could burn a peer's token | The bindings are part of the conditional update; a mismatch is refused and the token stays usable by its node |
| Low | `cloud/setup.ts` (`ExprsnChangeOwn`) | `s3:PutBucketTagging` replaces a bucket's whole tag set, so the deploy role could drop the `exprsn:*` tags the docs say are never removable | Granted only with the `exprsn:*` tags in the request (`ExprsnRetagOwn`) |

### Accepted, with why

| Severity | Where | Scenario | Why accepted, and what limits it |
| --- | --- | --- | --- |
| High | `cloud/setup.ts` (`ExprsnCreateTagged`, and `ExprsnTagOnCreate` for RDS, EKS, ElastiCache, Secrets Manager) | Create actions are conditioned only on the request's tags, and AWS checks the condition on every resource of the request, so a stolen deploy session can create on a foreign parent: snapshot any RDS database (`CreateDBSnapshot`, then restore the now-tagged snapshot), add a node group to a foreign EKS cluster, a listener to a foreign load balancer, a subnet or instance in a foreign VPC; the non-EC2/ECS tagging actions can still tag a foreign resource as managed | The fix is a statement per resource type (the new resource's ARN with `aws:RequestTag`, the parent's with `aws:ResourceTag`), whose effect can only be confirmed against a real account: it lands with the sandbox runs (B-10804). Until then: give Exprsn-AI a dedicated AWS account (the setup helper's advice), which leaves nothing foreign to reach; federation sessions last at most an hour; every call is in CloudTrail and every drift finding names its principal |
| Medium | `cloud/setup.ts` (`AWS_UNTAGGED`) | `acm:ImportCertificate` on `certificate/*` can replace any ACM certificate by ARN; `elasticloadbalancing:ModifyListener` on `listener/*` can repoint any listener | These resources carry no Exprsn-AI tags today; scoping them (`aws:RequestTag` on import, the controller's `elbv2.k8s.aws/cluster` tag on listeners) needs the sandbox check. A dedicated account limits it as above |
| Medium | `cloud/budgets.ts` `set`, `remove` | One `finops:manage` holder can lift the hard stop by raising the budget, turning the stop off or removing the budget, which the override's dual control does not cover | Setting budgets is that role's documented authority, and the budget suites rely on it; every change is audited (`cloud.budget.updated`, `.removed`) and goes to the account's FinOps readers. Dual control for loosening a budget while the stop holds is a follow-up |
| Low | `http/client-address.ts` | A tunnel peer that is also a local proxy's address (the operator names `loopback` and runs nginx on loopback) still passes on a client's `CF-Connecting-IP` | Configuration: the default no longer does it, and `docs/deploy.md` says never to name a proxy's address |
| Low | `cloud/gpu-enrol.ts` | A malformed CSR spends the token | The node gets a new token at the next reconcile (a minute) |
| Low | `cloud/autoscale.ts` `instanceForCertificate` | The node channel checks the certificate's state and expiry, not `notBefore` or the issuer's revocation | Node certificates are issued valid from now by this CA; revoking one marks its row, which the check reads |
| Low | `cloud/issuer.ts` `setTarget`, `cloud/cert-push.ts`, `cloud/cloud-dns.ts` | Platform-side uses (the issuer's publication target, certificate pushes, the ACME DNS account by name) accept a tenant's account, so a platform admin's mistake could hand the issuer's JWKS bucket to a tenant | Only platform admins reach these routes; the issuer check job reads the published copy back and alerts on any change |
| Low | `cloud/credentials.ts` | An issued Azure certificate's key and certificate stay after the account is removed; a failed `forget` (a sealed vault) is not retried; rotation error text is stored unscrubbed in the credential state and audit | The key never leaves the signer or transit and its certificate names one app registration, deleted with the trust; the problem detail a route returns is scrubbed |
| Low | `cloud/showback.ts` | Showback prefers a resource's `exprsn:tenant` tag, which someone with console access to a tenant account could change | Tags are written from the deployment's tenant, and showback is informational; a tenant account's costs stay on its own tenant's statement |
| Low | `cloud/tags.ts` `namePrefix` | Where a provider keeps no tags (DigitalOcean firewalls, Cloudflare), account `a`'s prefix `exprsn-a-` also matches account `a-b`'s resources, so the orphan sweep and the sandbox sweeper of one could see the other's in a shared provider account | Sandbox accounts are dedicated; one Exprsn-AI account per provider account is the setup helper's advice |
| Info | `cloud/setup.ts` `awsTrustPolicy` | The read, deploy and billing roles share one trust policy (`sub` = `cloud-account:<id>`), so a token minted for one role can assume another | Tokens live 300 s and are minted only inside the server; a `sub` per purpose is a follow-up |
| Info | `cloud/ai-gateway.ts` | At `internal` and below the gateway's cache is shared across tenants on one instance, a timing or `cf-aig-cache-status` oracle for an identical prompt | Only labels at or below `internal`; a per-tenant cache key is a follow-up |
| Info | `cloud/gpu-node.ts` | The node bootstrap pulls from the model mirror with `--insecure` | The mirror is inside the deployment's network and the node's egress guard admits only it; models are checked by digest |
| Info | `routes/admin/cloud-federation.ts` `GET /cloud/issuer` | A tenant's cloud admin sees the platform issuer's status (its publication target and key ids) | Public data: the issuer's discovery and JWKS are published |

### Credential paths, tested

| Provider and mode | Issue | Cache | Refresh | Rotate | Forget on removal |
| --- | --- | --- | --- | --- | --- |
| AWS federated | the issuer's token, `AssumeRoleWithWebIdentity` (`cloud-federation.test.ts`) | in memory per account and role | at two thirds of the session | the issuer's keys (`issuer.rotate`) | cache dropped on every instance; trust removed at AWS by the operator |
| AWS vaulted key | the vault (`cloud-credentials.test.ts`) | 50 s | on expiry of the cached value | `rotateAws`, overlap, sweep (`cloud-credentials.test.ts`) | the account's and its staged paths removed (`cloud-security-review.test.ts`) |
| Azure federated | the issuer's token, Entra (`cloud-federation.test.ts`) | in memory per account and scope | at two thirds | the issuer's keys | cache dropped |
| Azure secret or certificate | the vault, client assertion in the signer | 50 s and the token | at two thirds | `rotateAzure` (Graph), notices before expiry | paths removed (the certificate's key: accepted above) |
| DigitalOcean and Cloudflare tokens | the vault | 50 s | on expiry | guided replace (`PUT .../secret`, `runbooks.test.ts`), notices | paths removed |
| Any, on a credential change or disable | | | | | dropped on every instance (`cloud-security-review.test.ts`) |

### The nightly sandbox job (B-10804)

`exprsn-ai cloud:sandbox-run` ([runbooks/cloud-sandbox-nightly.md](runbooks/cloud-sandbox-nightly.md)) creates and
deletes billed resources by itself, so it refuses any account not marked `sandbox` (migration `167_cloud_sandbox_flag`;
marking needs a budget and an account with no other deployments), any account without a budget or at or past it
(actual or forecast, overrides never count, asked again before each stage that adds cost), and deletes only what the
provider reports with the account's `exprsn:*` tags (or its name prefix where there are none), older than a day,
never a database. It acts as a named person loaded fresh with their roles, so its audit trail is a person's. Its tests
run only against the fakes, and the workflow is disabled until the owner sets `CLOUD_SANDBOX_ENABLED`.

## Known gaps, tracked in the plan

- **The cloud epic (2.0.0: 1.9.99-final, Sprints 56 to 62).** The current list, gathered from what each sprint
  recorded here and in [cloud.md](cloud.md), with what later sprints closed taken out, is
  [cloud.md, Known gaps (2.0.0)](cloud.md#known-gaps-200). Those that bear on security: the IAM statements, the
  Azure custom role and the DigitalOcean and Cloudflare token scopes have not been tried against sandbox accounts
  (B-10804); Cloudflare's edge sees decrypted traffic (a deployment behind it holds at most `confidential`) and the
  server's Access check does not cover WebSocket handshakes; nothing runs `cloudflared` beside a remote data tier;
  ECS and App Platform hand the non-file-only secrets to the app as variables from their secret stores, and a
  DigitalOcean deployment keeps `DATA_KEY` as a file in its Kubernetes Secret; certificate pushes to cloud load
  balancers open the private key on the issuing instance; every node of a GPU node group can read the enrolment
  Secret (tokens are bound to a node's name and address); the cloud KMSes do not sign, so signing keys keep their
  own custody; non-HTTP protocol clients configured by the operator are not run through the metadata refusal;
  Bedrock Guardrails in `converse` mode may stream the guardrail's message before the turn fails. The security
  review of the epic (B-10803) and the acceptance of each finding are in the sections above.

- **Search index (1.9.0, Sprint 52).** The blind index matches whole folded words and 2- to 4-letter beginnings: no
  fuzzy matching, no stemming beyond a final plural "s", and scripts written without spaces match whole runs only.
  Word frequencies, co-occurrence, order and document length are visible to anyone with database access (see "Search
  index"); prefix rows of deleted text stay until the next rotation. A word common enough to pass 50,000 postings is
  matched in part of its documents. A write made while the process stops before its index write is caught by the next
  rebuild, not at once. Saved searches and "search within" on Messages, Groups and the feed are built (1.9.9-qa);
  the console has the Search screen, palette commands and the "/" shortcut, not a box in the top bar (it needs a
  change to `app.js`). A group's own posts (`group_posts`, its Posts tab) are not in the index; "Search in this group"
  searches the feed posts aimed at the group and, under Chats, its linked conversation. Saved searches stay when a
  person is offboarded until the tenant key is destroyed (`SavedSearches.removeAllOf` is not yet called by
  offboarding).
- **Feature flags (1.9.0, Sprint 52).** A `data-feature-flag` gate is cosmetic: a feature behind a flag must check it on
  the server as well. A `flags.changed` event reaches only sockets connected at the time; a console that was offline
  catches up at its reconnect or its next route change. A platform change makes every socket of every tenant fetch
  its flags once (coalesced), which is the cost of not sending values over the socket.
- **Active Directory, cloud directories and Exprsn platform accounts (1.9.0, Sprint 54).** AD's primary group (Domain
  Users) and `memberOf` range retrieval (over 1,500 values, when nesting is off) are not read; domain controllers from
  SRV records are ordered by priority and weight, not chosen by weighted random. Graph and Google directory pulls look
  up the users already linked (sync) and the account signing in; there is no full import of a directory's users ahead
  of their first sign-in, and no Graph delta queries. Platform CA tokens on the API need the CA's validation endpoint
  on every cache miss (for revocation and use counts; closed in 1.9.9-qa: the platform's v2 signature covers the
  nested fields, and `requireSignedClaims` refuses v1 tokens, which the platform accepts until its sunset,
  2026-11-18 by default), are refused when it cannot be asked (`503`),
  and a revocation is seen only after `tokenCacheSeconds`; the platform's bare token ids are not accepted, nor
  use-counted or persistent tokens. The platform's userinfo
  gives no organisations or roles yet, so its groups come from a memberships endpoint or claims when the platform adds
  them.

- **User stores (1.9.0, Sprint 54, migrations 140 and 141; governance in 1.9.9-qa, migration 142).** Until migration
  142 is applied, store changes, restores and removal work as in 1.9.0 (no dual control, no retention before removal).
  With it, dual control is `auto` by default: a tenant with a single identity admin has it off (the screen warns), and
  a tenant may turn it off; then one admin alone changes a store's connection, restores a backup and purges. Turning it
  off while it is in force needs a second admin, but adding a second identity admin account is not itself under dual
  control. Group mappings (the roles a store's groups grant) are changed by one admin, as before. A store backup of a
  `local` store carries password hashes and second factors (sealed under a KMS-wrapped key, signed by the KMS, opening
  only on this installation): whoever can restore it into a tenant can create those accounts there, so restore needs
  `identity:manage`, a recent sign-in and the restorer's (with dual control, the approver's) own grant and clearance for
  each mapping. Uploaded backups are capped at 50 MB and read whole into memory to check them. A finished users export
  stays in the blob store (sealed) until removed by hand; there is no expiry sweep yet. Scheduled backups are kept in
  the tenant's blob store beside the platform's backups, not in the platform backup set itself.
- **Albums (1.9.0, Sprint 53, migrations 135 and 136).** The file store does not accept videos yet (its scan reads
  text, documents and PNG, JPEG, WebP and GIF only), so albums hold images in practice; when video types are accepted,
  their metadata (MP4 `udta` and location atoms, WebM tags) will need stripping like EXIF before they are served. A
  share link to an album that is not public (a signed-in link within the tenant) is not offered. Upload links record
  the spam signals but are not gated by a spam response (there is no principal to hold), only by their own and the
  per-address limits; an upload counts against `max_files` as soon as it starts, also when its scan later rejects it.
  The adder check of the access rule loads each adder's workspaces once per read, which grows with the number of
  distinct adders in an album.
- **More connection types (1.9.0, migration `114_connection_engines`).** SQL Server, Azure SQL, Snowflake and BigQuery
  have no read-only transaction (Oracle has `SET TRANSACTION READ ONLY`): reads stay reads through the classifier and
  the account's grants. SQL Server reads run in a transaction that is always rolled back; Snowflake's `test` follows
  `SHOW GRANTS` only three roles deep and not future or database-role grants; BigQuery's `test` reports read-only
  without reading IAM (grant Data Viewer and Job User only). The classifiers cannot tell a user-defined or external
  function with side effects (an Oracle autonomous transaction, a Snowflake external function) from a read.
  Allow-list names compare case-insensitively, so a quoted mixed-case table and an upper-case one of the same name
  match one entry. The checked address is dialled for SQL Server and Oracle, but an Azure SQL redirect (Redirect
  connection policy) and an Oracle listener redirect (RAC, SCAN) go to hosts the server names, which the driver
  resolves itself: an Azure redirect must stay in the endpoint's parent domain and pass the host check, which runs
  beside tedious's own dial, so the login may reach that host before a refusal closes it; Oracle redirects are not
  checked. Oracle TLS needs the server certificate's DN (the host name cannot be matched against the dialled
  address) and has no wallet support (`NODE_EXTRA_CA_CERTS` for a private CA). Snowflake key pairs must be
  unencrypted PKCS#8 keys (sealed or in the vault); answers over 32 MB fail rather than stream. The HTTPS engines'
  hosts (`*.snowflakecomputing.com`, `bigquery.googleapis.com`, `oauth2.googleapis.com`, `login.microsoftonline.com`
  for an Entra service principal) must be on `CONNECTIONS_ALLOWED_HOSTS`. Tokens (Entra, Google, Snowflake JWTs) are
  cached per process.
- **Redis, RabbitMQ, Prometheus and InfluxDB connections (1.9.0).** None has a read-only transaction: reads stay reads
  through the command or query list and the account (a Redis ACL user with `+@read -@write`, a RabbitMQ user with no
  configure or write permission, a read-only InfluxDB token). Redis replies such as HGETALL, SMEMBERS and JSON.GET
  are fetched whole before the row cap; SCAN may walk one COUNT past the scan limit; cluster mode is not supported.
  RabbitMQ peeking (off by default) requeues messages, which marks them redelivered and can reorder a queue; overview
  totals and exchange names cover the whole broker. Prometheus has no per-series access: every label value of an
  allow-listed metric is readable. InfluxDB `SHOW MEASUREMENTS`, `FIELD KEYS` and `TAG KEYS` without FROM list every
  name (no values); v2 and v3 tokens are not checked for write rights. Key, queue, metric and measurement names
  compare case-sensitively. Answers are read whole up to 8 MB (RabbitMQ) or 16 MB (Prometheus, InfluxDB).
- **Document and key-value stores in the clouds (1.9.99-final, B-10304).** DynamoDB and Cosmos DB for NoSQL have no
  read-only transaction and no way to report a key's rights: reads stay reads through the operation list (Query and
  PartiQL SELECT; one SQL SELECT) and the credential (an IAM policy with Query, PartiQLSelect, DescribeTable and
  ListTables only; a read-only key or the Data Reader role), so Test connection says read-only from what the driver
  sends, not from the account. A DynamoDB SELECT is refused as a scan only when the table's keys were introspected;
  before that, any WHERE runs. The DynamoDB schema sample uses Scan (20 items), never a user's request. Cosmos DB
  cross-partition ORDER BY and aggregates the gateway cannot run without a query plan fail with its message.
  DocumentDB and Cosmos DB vCore do not report privileges; the stage refusals per service are this build's list.
  DigitalOcean MongoDB is dialled at one member, not through its `mongodb+srv` name. Entra tokens of Cosmos DB
  service principals are cached per process.
- **Cloud data connections (1.9.99-final, B-10306).** A leased user's password lives only in the memory of the
  instance that took it: a restart takes a new lease and the old user stays until its lease ends (the sweeper drops
  it). The lease engine `cloud-<name>` and its vault secret stay when the connection is removed (its leases are
  revoked); remove them under Vault. RDS IAM tokens are signed with the account's read session; the database user must
  hold `rds_iam` and SELECT only, which nothing checks. The Amazon RDS CA bundle is not fetched (the server does not
  reach out for it): without `caPem` an RDS or DocumentDB connection verifies TLS against the system store and fails.
  The tenant's allowed hosts gain the endpoint's host; a public endpoint still needs the operator's
  `CONNECTIONS_ALLOWED_HOSTS`.
- **Managed databases (1.9.99-final, B-10301, B-10303, B-10307).** The extension check reads the provider's
  allow-list and supported list, not `pg_available_extensions` (the control plane does not reach a private database;
  whoever connects, B-10302 or B-10306, can). DigitalOcean has no deletion protection of its own: the tag is honoured
  by Exprsn-AI only, so a delete made outside Exprsn-AI is not stopped. Azure and DigitalOcean final snapshots are
  running copies (billed); their snapshot prices in the price sheet are unconfirmed (`unverified`) and left out of
  totals. The MySQL integration run against managed MySQL in the sandbox accounts (open decision 18) is the owner's.
- **Moving the own database, caches (1.9.99-final, B-10302, B-10305).** The read-only window is enforced by the
  application (HTTP and the job queue) and checked by row counts; an update that changes no count during the window
  (a job finishing a row it had started) is not detected, so the move waits for running jobs first (at most two
  minutes). The old PostgreSQL database is made read-only by its `default_transaction_read_only` only where the
  install's role may `ALTER DATABASE`, and that default covers new sessions only; otherwise, and for SQLite and MySQL
  sources, only the window's flag keeps it read-only. A rollback after the switch refuses when tables changed, but
  compares counts too. The move targets PostgreSQL only (MySQL as the own database is B-10303); ECS and App Platform
  get no provisioned database (no file for the CA bundle). The CA bundles of RDS and Azure are fetched from the
  providers' published URLs through the egress guard when a deployment is wired; DigitalOcean's comes from its API.
  The sandbox run against a real RDS (open decision 18) has not been made: the tests use a local PostgreSQL with TLS.
  `/readyz` reads `INFO`; a managed Redis that renames or disables `INFO` is not checked.
- **OData and OpenAPI (1.9.0).** OData functions, actions and `edmx:Reference` documents are not followed; a filter
  path through a navigation property is checked on its first segment; allow-listing a service host lets every entity
  set in its metadata be read (no per-set allow-list). OpenAPI import follows only references inside the document,
  guesses the mapping one level deep, recognises credential parameters by name and API-key schemes, and creates GET
  endpoints only (a GET with side effects on a badly designed API is not detected).
- **GraphQL and SOAP API connections (1.9.0).** A GraphQL document is classified by syntax only (one `query`
  operation, depth and field caps): a query resolver with side effects on the remote server is not detected, and the
  document is not validated against the schema. A SOAP operation's read-only use rests on a name rule plus the
  editor's audited `confirmRead`; nothing on the remote side enforces it. The GraphQL schema helper's answer is shown
  to connection managers only and does not pass the untrusted-content checkpoint (every read does). WSDL and XSD
  imports, WSDL 2.0, rpc/encoded, SOAP headers (WS-Security) and MTOM are not supported; a pasted WSDL is limited by
  the 256 kB JSON body limit (2 MB by URL). A SOAP connection's test is a GET of the base URL.

- **Push providers and delivery (1.9.0, Sprint 49).** Push follows the in-app row: a notification the person's
  in-app preference holds for a digest or suppresses is not pushed at once either. Retries are new jobs, so a retry
  scheduled by `Retry-After` survives a restart but its pacing is per job, not per provider (no shared rate budget
  across devices). The external WebSocket kind opens one connection per send. Web Push and HTTP vendors go over
  HTTP/1.1 (`guardedRequest` dials the first checked address only); APNs and FCM over HTTP/2. Cached credentials and
  OAuth and APNs tokens are per process. The Platform screen offers tenant overrides to holders of both permissions;
  a tenant admin without `platform:manage` uses the API for now.
- **Push devices and notification preferences (1.9.0, Sprint 49).** A session that merely expires (idle or absolute
  timeout) leaves its devices active until they are pruned; only revocation ends them. Every `revokeAllForUser` ends
  devices, so a role or clearance change also ends them and the apps register again at their next sign-in. A token
  moves to whoever registers it next in the same tenant (a handed-on device), which a person holding someone else's
  token could use to take over their notifications to that device; tokens are unguessable provider values, so this
  needs the token itself. The digest summary of held push items is an in-app notification, so a kind that is instant
  in the app but held for push shows twice in the inbox. The time zone is kept with the notification settings, not
  on the profile.
- **Scan gate and vault seal (1.8.0, Sprint 48).** The server stores and judges results; it does not run Trivy or a
  SAST tool itself (CI does, against the Trivy mirror's database). A promotion to test without a chosen package builds
  a new package that can have no result yet (allowed with a warning, or refused under `missing: refuse`: promote a
  scanned package instead). Clearing a SCRIPT_IMAGE_* override (back to the default image) is not gated. In local KMS
  mode (DATA_KEY in the app's own configuration) the key stays in the process's memory while sealed: the seal is the
  refusal of every key operation and the dropped caches, and only the signer drops the key itself; JavaScript strings
  (the base64 copies) cannot be wiped, only released. Caches outside the listed ones keep what they hold until they
  expire (the shared response cache holds sealed rows only). Jobs already running when the seal fires may fail and
  retry. Unseal progress is per instance: every holder must reach the same instance (or use the CLI). With one signer
  per host, the other hosts' signers are unsealed with `vault:unseal --signer-only`. With OpenBao the app does not
  seal (seal OpenBao). The break-glass page sends shares to the server; prefer the CLI on a trusted host.
- **App roles and use limits (1.8.0, Sprint 48).** View, chart, report and dashboard sharing has no subject list (a
  shared object goes to every reader of the app, whose rows follow the policies), so it cannot name an app role.
  Keys issued under a dynamic vault lease (`vault:apikey:exprsn/...`, B-9301) and sessions take no `max_uses`. A use
  is spent before a request's scope and signature checks, so failed requests count against the limit by design.
- **Scheduled delivery (1.8.0, Sprint 44).** "Only if changed" compares a hash of the rendered bytes, so a format
  that stamps the render time into the file (a PDF or workbook with a creation date) counts as changed every time.
  The email's message is not screened by a guardrail (it is escaped, goes only to people a designer chose in the same
  tenant, and is sealed at rest). Destinations cannot be edited in place (delete and subscribe again).
- **Image metadata (1.8.0, Sprint 47).** Only JPEG, PNG, WebP and GIF are cleaned (the file store accepts no other
  image type). In a JPEG, segments after the first scan are treated as between scans; a metadata segment hidden in
  the entropy-coded data itself is not looked for. The ETag of a DAV resource is the original's even when a reader is
  served the cleaned copy. A file shared by link or with another workspace is always served cleaned, also to its owner
  on those paths; the owner's original is on the file's own routes. Version compare reads at most 4 MB a version and
  extracts text from PDF and Word only (other Office documents are not compared); the diff is by line, not by word.

- **Saved connection queries and REST connections (1.8.0, Sprint 45).** A write query is stored but cannot run
  anywhere: write paths on registered connections stay closed until a separate write account exists. Saved-query paging
  is by offset (rows inserted between pages shift them); OpenSearch and MongoDB queries do not page past the first
  result. The `db-query` guardrail sees the parameter values as text beside the query, and a redaction refuses the
  run rather than editing bound values. Lookup options and OAuth2 tokens are cached in each process (30 seconds;
  until shortly before the token expires), so a revoked grant or a rotated client secret can serve a cached answer
  until then. REST endpoints are GET only, JSON only, with no mutual TLS and no per-endpoint rate limit; a REST
  entity source is read-only, and the untrusted-content checkpoint screens a page of rows as one text, so one hostile
  item withholds the page. Knowledge sources read at most 5,000 rows a sync. Lookups and knowledge syncs run on behalf
  of the design (the app or the base), not of the reader's own `connections:query`.

- **Workflow webhooks and run retention (1.8.0, Sprint 46).** The workflow hook has the app flow hook's gaps (a
  shared symmetric secret, no sender address list, no grace period on rotation, the rate limit per hook rather than
  per sender, the payload in a model step's prompt without trust marking). A refused request for an existing
  workflow is audited and recorded as a delivery, bounded by the rate limit. The owner is the person who turned the
  hook on, not the publisher of the version it starts. Retention deletes rows only: a pruned run's chain nodes,
  trigger firings and references held by other features (app deployments, knowledge reviews) keep its id, and a
  database backup still holds it until the backup expires. There is no archive before the prune.

- **App flow webhooks (1.7.0, migration 082).** The secret is a shared symmetric key: whoever holds it can start the
  flow, and the server cannot tell senders apart; there is no asymmetric (Ed25519) option, no source-address allow
  list and no grace period for the old secret on rotation (senders must switch at once). The rate limit is per flow,
  not per sender, so one sender can use a flow's whole budget. The payload is screened by the content rules once, as
  JSON text; a model step that reads `{{input.payload…}}` sees it inside its prompt without the trust marking tool
  results get. A refused request is audited, so a flood of bad signatures is bounded only by the rate limit.

- **The vault's platform scope and named keys (1.7.0, B-9201 to B-9205).** Sessions, API keys, app passwords,
  recovery codes, links and feed signatures are keyed with named HMAC keys in the vault (`sys/transit/<name>`), each
  with versions, in place of the one `SESSION_SECRET`; a key is rotated and its previous version retired from
  `/api/admin/platform/vault`. What this does not do yet:
  - `SESSION_SECRET` is still required, and it is still version 1 of every key until an admin rotates the key and
    retires version 1. Until then a leak of it is as bad as before. Rotation and retirement are not scheduled, need
    one holder of `platform:manage` with a recent sign-in, and are not under dual control. Retiring a version ends
    everything issued under it at once, the admin's own session included.
  - The secrets of the platform keys are held in the memory of every server process (they key a digest on every
    request). They are not in the signer process or OpenBao transit: B-9207 registered the asymmetric signing keys
    and lets a transit signing key be held there, and left these HMAC keys where they are.
- **Sessions and API keys as leases (1.7.0, Sprint 42, B-9206).** With `CREDENTIAL_STORE=leases` a new session and a
  new API key are leases that hold only a verifier. What this does not do:
  - The default is `table`, so nothing changes until the setting is changed, and existing `exai_k1_` keys stay rows
    of `api_keys` until they expire or are replaced; nothing converts them.
  - A revoked lease is refused at once on the instance that revoked it and on the others when the bus event reaches
    them, at the latest after `VAULT_LEASE_CACHE_MS` (1 second). A row of `sessions` was refused on the next request.
  - A lease session's data (stage, method, address, user agent) is JSON in `vault_leases`, not sealed, as the
    columns of `sessions` were not.
  - A build from before the migration refuses lease sessions and `exai_k2_` keys (it does not read them): going back
    signs those people out and stops those keys until the newer build runs again.
  - No screen lists session or API-key leases as leases; they appear as sessions and keys.
- **Signing keys as vault keys (1.7.0, Sprint 42, B-9207).** The registry points at keys; it holds none. Gaps:
  - A key whose private half is `sealed` in the database (every key made without the signer or OpenBao, and the
    ACME account key) is still opened in this process to sign. Registering it does not change that; the list marks
    it `isolated: false`.
  - Only OIDC and webhook keys are rotated from the vault. The CA, OCSP, content-credential, AT-Protocol and PDS
    keys are listed and rotated on their own screens, if at all.
  - A key made by a domain later (a scheduled OIDC rotation) is not registered until someone registers again.
  - Deleting a held transit key removes its rows here; a key in OpenBao transit stays in OpenBao.
  - Registration, removal and rotation need one holder of `secrets:admin` with a recent sign-in; none is under dual
    control.
- **Groups as access subjects (1.7.0, Sprint 43, B-98).** Gaps:
  - Membership is read at every decision and nothing is cached, so a busy folder grant or vault path asks for the
    caller's groups on each request.
  - A group grant to a file or folder gives read only; it cannot give write.
  - A folder grant covers what is below the folder when a file is read; moving a file out of the folder ends it, and
    moving one in starts it, without an audit entry for the grant.
  - The ownerless sweep tells managers once per group; a group that stays ownerless is not reminded.
  - App group scopes hide a scoped app from its own designers who are not group members; holders of `tenant:manage`
    always see it.
- **Response cache (1.7.0, Sprint 43, B-99).** Gaps: an entry is served for its TTL even after the model's weights
  change under the same digest-less name (servers other than Ollama report no digest); retrieved context is part of
  the key, so a knowledge base that changes misses the cache, but a memory or knowledge item changed and changed back
  serves the older answer; `/v1` requests with tools or context are never cached.
- **`did:exprsn` (1.7.0, Sprint 43, B-113).** A user's `did:exprsn` has one key and no rotation: the DID is the key, so
  a new key is a new DID (the platform's method has none either). `alsoKnownAs` is added only when this server
  resolves its own users' DIDs.
- **Plugin UI surfaces (1.7.0, Sprint 43, B-112).** The block types are fixed (text, key-value, table, action); a
  surface cannot draw anything else. A surface's data is fetched as the viewer on every render, with no cache.
- **Cross-posting (1.7.0, Sprint 43, B-114).** Gaps: only this server's own PDS (the external-PDS half of PDS-21 is not
  built); image alt text is the file name, since posts have no alt text; the public network step (relay crawl,
  AppView indexing) has not been run against live infrastructure (B-11401's runbook is in `docs/deploy.md`);
  a record deleted from the PDS outside Exprsn-AI is written again on the post's next change.
- **Third-party credentials in the vault (1.7.0, Sprint 42, B-9208).** Gaps:
  - The sealed values are kept beside the vault's copies until a later clean-up, so until then a third-party secret
    is still held outside the vault as well; the move adds policy, versions and the read audit, it does not yet
    remove the second copy.
  - A moved credential is read from the vault at every use and each read is an audit entry; a busy webhook or
    connection writes many.
  - The service `integration.<kind>` reads every moved credential of its kind in the tenant; the grant is per kind,
    not per integration.
  - Deleting an integration leaves its vault secret behind.
  - Platform-scope credentials (certificate push hooks, registry push targets, database lease engines' admin
    passwords, plugin configuration) are not moved. Each person's MCP access and refresh tokens and the tokens of
    SIEM destinations are left sealed on purpose: the first are a person's own delegation, replaced at every refresh,
    and the audit forwarder must not read through the vault whose reads it forwards.
  - Moving and restoring need one holder of `secrets:admin`; neither is under dual control.
  - Short-lived values are keyed with the current version only: OIDC authorization codes, pushed requests, device
    codes and replay markers, pending sign-ins, consent and re-authentication tokens, DPoP nonces. A rotation of
    `federation` fails the flows in flight at that moment. OIDC client secrets and refresh tokens accept every
    accepted version.
  - `identifier` keys stable identifiers (SAML persistent NameIDs, channel customer keys, the hashed address on a
    held form submission): rotating it changes them. The settings fingerprint is still keyed with `SESSION_SECRET`.
  - A process that never opens the scope (setup scripts and CLI commands other than `admin:create` and
    `tenant:create`) keys with `SESSION_SECRET` alone: what it issues is version 1, refused once version 1 is
    retired, and it does not accept what later versions issued.
  - Uses of the platform keys are audited as a count per service and minute, not one entry per read, and the count
    of the last minute is lost if the process is killed.
  - The first version's material is checked against nothing: a server started with a different `SESSION_SECRET`
    after the scope exists uses the stored version 1, not the new value.
  - A lease check is answered from memory for `VAULT_LEASE_CACHE_MS` (one second by default): with more than one
    process and no Redis (which B-9001 refuses), or while Redis is down, a revoked lease is accepted for that long.
    Database leases keep their own table.
- **Vault reference owners (1.7.0, B-9209).**
  - Handing a reference over is per person and reference text, not per integration: every integration in which
    that person saved the same reference follows. Nothing lists the references a person saved, so the admin types
    the reference as the integration holds it.
  - The handover is by one holder of `secrets:admin`; it is not under dual control. It needs the owner to hold
    `read` on the path already, so it cannot widen who reads a secret, but it does remove the stop that disabling the
    person was.
  - A reference owned by a workspace resolves under grants made to that workspace, which its members also read
    with. A service owner (`integration.<name>`) has no members; its grants are made under Policies.
  - The reference reads at the label the secret had when it was handed over. A secret relabelled higher stops
    resolving until the reference is handed over again.
  - References that take an API-key lease, references in workflow graphs (read as the run's principal) and plugin
    settings are not covered; they resolve as before.
  - Existing references were not converted. On this installation none of the user stores, connections, MCP
    servers, model-server tokens, channels or import repositories holds a vault reference with an owner today.
- **Groups: roles and event extras (1.7.0, B-9705 and B-9707).**
  - A custom role with the right `roles` lets its holders give roles and make custom roles up to their own rights.
    Rights are compared as sets, so a holder of such a role cannot change the role of a guest unless the role also
    carries `rsvp`: a member who holds any right the caller lacks is out of their reach.
  - The admin tier holds `settings`, so an admin may change the group's label and visibility and link or unlink its
    conversation, which only owners could before there were admins.
  - Everyone in a group is in its linked conversation. A guest, or a custom role without `post`, can write there
    although they cannot post in the group.
  - An invitation names a tier, not a custom role. `group.member.role` is audited; nothing notifies the group's
    owners when a role's rights change.
  - A holder of `groups:manage` holds every right in every group of their workspaces, whatever roles the group has.
  - The waitlist promotes in order but passes over a party that does not fit what is left, so a single person behind
    a pair can be promoted first. Places are freed only by an answer changing, a larger capacity or an organiser's
    decision: a member who leaves, is removed or is banned keeps their RSVP row and their place until an organiser
    changes it.
  - An event narrowed to `members` or `organisers` keeps the RSVPs of people who can no longer read it; they are
    told nothing more and are not counted out.
  - The virtual URL is screened as text by the `user-input` guardrail; the address is not fetched or checked against
    the tenant's list of allowed hosts. A redaction refuses it, as a block does.
  - A draft's title and description are not screened by anything the published event is not. Publishing is not
    under dual control.
  - Tested on SQLite only: the row lock that makes a promotion happen once is not exercised on PostgreSQL or MySQL.
- **Groups: cases for moderators, and the linked conversation (1.7.0, B-9706 and B-9709).**
  - A group's cases stay flags of the tenant: its reviewers see and decide them too, and nothing stops a tenant
    reviewer and a group moderator from acting on the same case one after the other.
  - A moderator of a group reaches a channel's cases only if they moderate the channel; the group's owners reach all
    of them. A suspension or ban from a case stands in the group the content is in, so one from a channel's case does
    not reach the group.
  - A group ban or suspension cannot be appealed through the appeal routes: those cover a hidden object and an
    account sanction. The person asks a moderator, who lifts it.
  - A warning is a notification and a row of the case; it is not counted anywhere and has no effect by itself.
  - The reporter of a case may decide it when they are a moderator. Only the author of the content is kept from it.
  - Assigning a case to a group moderator takes it out of the tenant reviewers' queues until it is handed back, as
    any assigned flag is; they can still open it by its reference.
  - A linked conversation's label is checked when it is linked and when the group's label is raised. Nothing lowers
    or raises the conversation's own label afterwards, and members not cleared for it are simply not let in.
  - A group may grow past `MESSAGING_MAX_MEMBERS` after it was linked; the limit is checked at linking only.
  - Someone who leaves a group and joins again reads its conversation from the second joining on. Their read position
    and notification settings from before are gone.
  - A holder of `groups:manage` who is not a member acts as owner of the group and can link or remove the link, but
    does not read the conversation: only members do.
  - Group bans, invite links and event notices (`063`, `062`) are not in the tenant offboarding list; the two tables of
    `064` are.
- **Groups: bans, suspensions, invite links and messages (1.7.0, B-9701 and B-9702).**
  - A holder of `groups:manage` acts as owner whatever stands against them as a member, so a ban does not keep a
    workspace's group manager out. Owners are not banned; they are made moderators or members first.
  - A suspended member reads a public group as any non-member does. A suspended member of a hidden group no longer
    sees it at all, so they cannot leave it until the suspension ends or is lifted.
  - A ban or suspension ends when its time passes without a job: the next check ends it. Nobody is told that it
    ended by time.
  - The reason is read by every moderator of the group and is not shown to the person. A guardrail hold on a
    reason or a message refuses it (422); it does not wait for review.
  - An invite code is twenty characters (100 bits), kept as a keyed digest; lookups and redemptions are limited to
    20 a minute per person. Whoever holds a code and is in the group's workspace and cleared for its label learns
    the group's name, hidden or not, as an invitee does.
  - A link admits as a member only, into a group of any join mode. Withdrawing a link or banning its maker leaves
    the people it admitted as members.
  - Retiring the platform's `link` key version a code was digested under ends that code.
- **Groups: profile fields, paging and notifications (1.7.0, B-9703, B-9704 and B-9708).**
  - A group's tags, website, avatar and banner are shown to whoever may know the group exists, like its name; they
    are not kept to readers of its content as the description is. Tags and the website are stored in the clear.
  - The website is checked for its form only (an `http(s)` address without credentials); nothing fetches it and no
    list of hosts applies. The console opens it in a new tab with `noopener noreferrer nofollow`.
  - The avatar and banner are files of the group's workspace at the group's label when uploaded. Raising the group's
    label later does not raise the file's; the image is still only served to viewers who clear the file's own label.
  - Lowering the member limit below the present count removes nobody, and a workspace or tenant has no limit of
    its own. The creator of a group or channel is its first member whatever the limit.
  - A notice about a group as a whole (a new event, a join or a departure) goes to the members who are active, in
    the workspace by membership and cleared; someone who reaches the workspace by a role alone is not told. Notices
    to an event's attendees use the request-time check for each of them.
  - "Notify attendees" is limited to five messages in 24 hours per event, not per organiser or group, and a
    message cannot be withdrawn once sent. A guardrail hold on a message refuses it (422); it does not wait for
    review as a group post does.
  - The search is a substring match over lower-cased text (`LIKE`), without an index: on a very large group each
    page scans the group's members.
- **Dynamic API-key leases (1.7.0, B-9301 and B-9302).** A vault role issues a short-lived API key under a lease:
  this server's own keys from the built-in provider `exprsn`, or GitHub App installation tokens from a registered
  provider. The key is returned once; an `exprsn` key is accepted only while its lease is live and never carries more
  than the role, its reader and the request's own credential. What this does not do:
  - Every read of a role's path or of its reference (`vault:apikey:<provider>/<role>#key`) issues a new key; the
    earlier ones live until their lease ends. `VAULT_APIKEY_LEASES_MAX` bounds the live leases of one role per
    person, so a workflow that reads a reference more often than its leases end is refused (429) until they do.
  - An outside key is kept sealed with its lease (tenant key) because GitHub revokes a token only when it is
    presented. Anyone who can unseal tenant data can read a live outside key.
  - A provider whose revoke keeps failing leaves the key usable at the provider until it expires there (an hour for
    GitHub); the lease waits in `revoking` and is retried, and nobody is notified.
  - The role is the ceiling for an outside key only as far as the provider reports what it issued: a GitHub token
    with more permissions than asked for is revoked and refused, but repositories are not compared.
  - Removing a role or disabling a provider does not end the leases already issued; revoke them.
  - A provider's admin credential is read as the person who registered it: when they are disabled or lose
    `secrets:read` or the grant, the provider neither issues nor revokes until someone saves the reference again.
  - The GitHub provider was built and tested against a fake; it has not been run against GitHub.
- **Evidence retention and legal hold on cases and objects (1.7.0, B-9501 to B-9504).** What a moderation action hid
  or took down is kept until its case and any appeal close, and a legal hold may name a case or one object. What
  this does not cover:
  - A case closes by time: `MODERATION_EVIDENCE_DAYS` after the last decision (the action, the flag's decision, an
    appeal's). An appeal filed later is still accepted, but the content may be gone by then.
  - The purge paths that honour it are the file purge and trash emptying, file retention and the version cap,
    conversation retention, channel retention, and the purges of held writes and held form values. Not covered: a
    knowledge document removed by a sync, by deleting its source or its base; a record deleted because its outside
    row is gone; media assets and generated images, which have no purge; deleting a workspace.
  - A user-facing delete is refused for a kept conversation, direct message, knowledge document and record. Feed
    posts, comments and group posts are soft-deleted and their text stays, so they are not refused.
  - The refusal says the object "is kept by a moderation or compliance decision". It does not say which, but a
    person who meets it on content no moderation action touched can infer a legal hold.
  - Offboarding a tenant with an active legal hold is refused. An open moderation case does not stop offboarding.
  - A flag's text is never purged, with or without a case. A hold on a case keeps the object the flag points at and
    the object of every action taken from it, not other objects of the same conversation or author.
  - The evidence export holds the text each domain gives a check and, for a file, its versions with their hashes;
    the file's bytes are not in it.
  - Holds and their exports are dual-controlled: a tenant with one compliance manager can place neither.

- **Held messages, group posts, comments and edits (1.7.0, B-9401 to B-9404).** A write the `user-input` guardrail
  holds is stored sealed and read by its sender only, until a reviewer other than the sender accepts it or the
  re-screen job gets a fresh verdict. What this does not cover:
  - The sender learns that a rule matched (`202` and "held for review"), as a refusal told them before.
  - A reviewer of a held direct message reads its text, the conversation's title and member names, and the five
    messages before it, each at the reviewer's clearance. Direct conversations have no workspace, so every holder of
    `flags:review` or `moderation:review` in the tenant may review them. Reading a private conversation this way is
    audited only as the decision (`moderation.held.delivered` or `.rejected`); opening the item is not audited.
  - A message delivered after a hold keeps its original time and place in the timeline. It counts as unread for
    members who had read past that time (`dm_messages.released_at`), but the unread digest of
    `POST /api/messaging/conversations/:id/digest` still goes by time and can leave it out.
  - While a model-backed rule cannot run, what people send is held without a flag, up to
    `HELD_OUTAGE_MAX_PER_TENANT` (500) per tenant and `HELD_MAX_PER_AUTHOR` (20) per author; past either the write is
    refused as before. Reviewers are told once an hour and the count is on the Moderation screen, but there is no
    metric or alert rule for it yet. The re-screen stops at the first item whose check still cannot run, so one rule
    that stays down holds back every item behind it in that tenant, including those other rules would pass.
  - A held edit and its message can drift: the message may be pinned, reacted to or replied to while the edit waits,
    and the accepted edit then replaces the text those refer to. A second edit is refused until the first is decided.
  - A rejected message, post or comment stays readable by its sender, with its text, until `HELD_KEEP_DAYS` (30) after
    the decision, when it is deleted. It is not under the conversation's retention or a legal hold in that time.
  - New feed posts that a rule holds for a reviewer keep the queue entry they have had since 1.4.0 (a flag on the post,
    decided by the workspace's `feedApprover`); the other held writes are decided by any flag or moderation reviewer.
  - The built-in tool `messages.send` now returns `state: held` where it failed before (the post tools already
    returned a post's state); an agent or workflow that does not read the state will take a held message for a sent
    one.

- The AI inventory, analytics and audit streaming (1.6.0, Sprint 38a). The inventory's owner gate applies to agents
  only; profiles, workflows and tools publish without an owner, and the gate is off until a model admin turns it on.
  Known issues count open flags from agent and workflow runs and failed evaluations; flags raised on a profile's
  conversations are not linked to the profile, and models and tools show no issues. The register is a synchronous
  download (no sealed export job), so it is not kept for later download. Analytics prices are per model or per pool,
  not per instance: the meter records the pool a request ran on, not the instance. Costs are computed on each read and
  nothing is stored per request, so a price change changes past months' chargebacks; keep the export if a figure
  must stand. The group dimension counts a user's records once per group they belong to, so group rows do not sum to
  the tenant's total. A JSONL export redacts rows above the requester's clearance to their hashes; the offline
  verifier checks the chain and the checkpoint's hash but not its HMAC (that needs the key: `audit:verify`). Tenant
  SIEM forwarders buffer in memory on the instance that appended the event (as the platform stream does): on a
  multi-instance install each instance delivers the events it appended, and a restart drops what was buffered
  (counted on the row only if the counters were flushed). A syslog destination opens one TLS connection per batch and
  sends no structured data elements; HTTPS destinations get no retry on a 4xx beyond the forwarder's backoff.
- HTTP tools and prompt-injection defence (1.6.0, Sprint 37a). The heuristic injection classifier is a set of
  patterns tuned on the corpus it is measured against (detection 100%, false positives 3.3% on it); new phrasings,
  other languages than English, Spanish, French, German and Dutch, and attacks split across chunks are missed, and a
  benign text quoting an attack (security training) is flagged. A guard-model rule (any profile, through the
  `injection` mechanism) is the stronger option; whether the platform should ship one by default is an open decision.
  Annotate mode only warns the model, and trust marking lowers but does not remove the chance that a model follows an
  instruction it reads; block mode drops whole chunks, including the rest of their text. Memories are not wrapped as
  untrusted (they are proposed through the memory checkpoint and accepted by a curator), and neither are a delegated
  agent's answer or a workflow's output (a workflow HTTP step's answer reaches a later model step unmarked). The
  injection counts are per tenant and source, not per workspace on the Guardrails screen. HTTP tool answers are not
  scanned for malware and must be JSON or text; a tool's vault references resolve as its author, so a tool keeps
  working for its callers until the author loses `secrets:read` or the vault policy changes, and stops for everyone
  then. Public hosts are allowed per tenant, not per tool (one list shared with workflow HTTP steps and webhooks, as the
  open decision assumes); the guard re-resolves on every call, so a host whose DNS answer moves to a refused address
  is refused at that call, not before. Only `read` HTTP tools run in the registry's test harness; a write tool is
  tested through an agent run with its approval.
- The MCP server and MCP authorization (1.6.0, Sprint 37b, B-7101 to B-7103). The server offers no sessions, no
  event stream and no resources or prompts: a long agent run or a workflow paused on an approval answers with a handle
  after 20 s, and the client asks again with `exprsn_run_status`. Held calls are matched by the arguments' hash, so a
  client that changes any argument asks again; the approval is per call, with no "trust this client" setting. Agents
  published to a workspace run as tools with their own approvals inside the run (decided on the Runs screen, as in the
  console), not with a held call. The DNS-rebinding check refuses any foreign `Origin`, so a browser-based MCP client
  on another origin cannot use the endpoint. Dynamically registered clients are not removed when unused. On the client
  side, refreshes are serialised per server and user on one instance only: two instances refreshing the same rotating
  refresh token at once can make the authorization server revoke the grant, and the person then connects again.
  Discovery and token requests reach internal hosts only (or those `MCP_ALLOWED_HOSTS` names), so an MCP server whose
  authorization server is public needs that host allow-listed. A server's OAuth configuration removed or rediscovered
  for another issuer leaves tokens users already connected until they expire or are disconnected.

- Model servers beyond Ollama (1.6.0, Sprint 35a, B-4301 to B-4307). What the digest check cannot cover for a
  server-held model (`format: server`): the gateway never sees the weights, so it cannot verify which file answers
  behind the model id the server lists, that the file is GGUF or safetensors, or that it stays the same between the
  conformance run and later requests; an operator who swaps the model behind the same id (an `mlx_lm.server` or
  `llama-server` restarted on another file with the same alias) is not noticed. None of the servers targeted here
  exposes a file hash in `/v1/models`, so the backlog's "where the server exposes it, the file's hash" is not
  implemented; the model id is the only identity, and approval should be read as approval of the server's operator
  as much as of the model. The probe and the evaluation trust what the server answers. A Unix socket is not checked
  against the egress policy: its file permissions are the only access control, and `fm serve` itself has no
  authentication (run it on a socket only the service user can open, or on loopback, never on `0.0.0.0`). A bearer
  token is read from the vault once per client and kept in memory until the instance's address or token reference
  changes or the server restarts, so a token rotated in the vault reaches the gateway only then; it resolves as the
  person who saved it, and stops resolving when they lose `secrets:read` or leave. Chat Completions servers report no
  residency, so the memory planner, the anti-thrash limit and pinned residency do not apply to them, and usage is
  estimated at four characters a token when the server reports none (`fm serve` while streaming). When a server
  refuses `/v1/embeddings`, embedding requests go to any other instance the embedding model is placed on, not
  specifically one in the same zone. The Pools screen's own instance form still edits only Ollama settings; kind,
  socket and token are set from the Models screen's Model servers.
- Social and messaging administration (1.6.0, Sprint 35d, B-4206). The policies need `social:manage` (decision Q4);
  turning the full `user-input` check off for a workspace's posts or changing who approves held posts also needs
  `moderation:manage` and is audited (`social.policy.updated`, `weakened: feedGuard`). With the check off, posts
  labelled internal or below are still checked against the platform baseline (the engine keeps platform sets only,
  so no tenant setting relaxes the baseline) and anything above internal, and every comment, is checked in full. A
  held post is decided only by holders of the permission the workspace names (any flag reviewer by default, or `feed:manage`,
  `guardrails:manage` or `moderation:review`), never by its author. Exporting another member's conversation is under dual control
  (decision Q5): a holder of `social:manage` asks with a sealed reason and a recent sign-in, a second platform admin
  (`platform:manage`, another person, also with a recent sign-in) approves, and only then does a job read the
  messages; the CSV is sealed with the tenant key in the blob store, downloadable by the requester alone (cells
  defused against formulas), and the request, decision, export and download are audited with the reason and both
  names. The members are not told, by design. A revoked calendar feed answers 404 like an unknown one. Closing a
  user's rooms disconnects their sockets on every instance over the bus; it is not a sign-out. Gaps: realtime counts
  are per instance (the screen says which), and signals are counted only when relayed or refused; an export holds at
  most 50 000 messages (the CSV says when it was cut) and stays in the blob store until the tenant is offboarded; a
  workspace contact rule of `admins` lets holders of `social:manage` or `tenant:manage` start conversations with
  anyone in the workspace (each person's own contact rule and blocks still apply).

- Groups depth (1.6.0, Sprint 36a, B-4401 to B-4405). Coordinates of groups and events are kept in the clear (the
  place name is sealed) so the database can filter on them; anyone with database access reads where a group meets.
  A group's place is shown to readers of its content (for a public group, everyone in the workspace); whether it
  should be for members only is an open decision in `Backlog-1.6.0.md`. A distance filter only matches places the
  caller may read, but the answer's order and `distanceKm` tell a reader roughly where a public group is, by design.
  Discovery's `sharedMembers` counts members of a group the caller shares another group with, including private
  groups the caller may see listed: it is a count, never names, but it says that some of the caller's co-members
  belong. Trending counts joins and posts of private groups too (their names are listed to the workspace anyway);
  hidden groups never trend. Channels follow their group: a `groups:manage` holder or an owner of the group acts as
  owner of every channel, including hidden ones. A channel's members are not removed when a later label change
  leaves them below the channel's label; they lose read access by the clearance check, as with groups. The
  `groups.trending` job shares `FEED_TRENDING_MINUTES` and `FEED_TRENDING_HOURS` with hashtags; there is no separate
  setting. Over DAV, a member's calendars include their channels (`includeChannels`). PostGIS is created by the
  migration only when the role is a superuser or it is installed already; otherwise the bounding box is used, with the
  same results.
- Tenant provisioning templates (1.6.0, Sprint 35d, B-4501). Only a system admin provisions a tenant from a
  template (`POST /api/admin/tenants/from-template`, or `exprsn-ai tenant:create` on the host), and only a template
  whose highest workspace ceiling the caller's clearance reaches. Templates are code, not data: their custom roles
  hold member-baseline permissions only (a role with an admin permission stays under B-3302 dual control and is never
  part of a template), their profiles are drafts without a model (a model admin of the tenant picks and publishes
  them), and the first admin is a `tenant-admin` (never `system-admin`) who must enrol a second factor at first
  sign-in. By default the first admin gets a single-use enrolment link (`PASSWORD_INVITE_HOURS`) that sets the
  password and opens only factor enrolment; a password given instead passes the password policy before anything is
  created, and is never stored or echoed. Every part is audited in the new tenant's chain and the provisioning
  admin's (`tenant.created` with `detail.template`, the parts' own events, `tenant.template.applied`). The issuing CA
  is made only when a platform root and key custody exist; otherwise it is reported as skipped. Gaps: provisioning
  is not one transaction, so a failure part-way (a database fault after the tenant row) leaves a tenant with the parts
  made so far (visible on Tenants and in its audit chain, to finish by hand or offboard); a template's workspaces get
  no directory group mappings; templates cannot be edited from the console.
- Overview and Jobs and queues (1.6.0, Sprint 35b, B-4202, B-4203). Reading needs `tenant:manage` or
  `platform:manage`; a tenant admin sees and acts on their own tenant's jobs only (another tenant's id is `403`, its
  jobs `404`), a system admin every tenant's (Q9). Draining an instance, pausing a job type and running or pausing a
  schedule act on every tenant and need `platform:manage`; a drain also needs a browser session and a sign-in within
  `STEPUP_WINDOW_SECONDS`. Every change is audited in the actor's tenant (`platform.alert.acknowledged`,
  `platform.instance.drained`, `jobs.*`), including a system admin's cancel or retry of another tenant's job, which
  that tenant's chain does not record. Payloads are shown as keys only; error messages and progress messages are shown
  as the job wrote them, so a handler that puts tenant content in an error would show it to the tenant's admins (and
  to system admins). Dead letters are the caller's own tenant only and need the domain's permission to redrive or
  discard. Gaps: a drain lasts for the life of the process (a restart is a new, undrained instance) and does not end
  open chat streams or sockets, which finish or move on their own; instance rows are written by the instances
  themselves, so a process that can write the database can report any state for itself; the cache statistics are the
  answering instance's since it started; the schedules listed are those registered on the answering instance (an
  API-only instance lists none); signer and worker processes (training, images) are not instances here, their
  health stays on their own screens.
- Configuration (1.6.0, Sprint 35c, B-4205). The screen never receives a secret's value: instances report a secret
  as set or unset, its length, the `<NAME>_FILE` path and mode, and an HMAC-SHA256 fingerprint keyed with
  `SESSION_SECRET` (16 hex), stored in `platform_instance_settings` so that instances can be compared. Anyone who can
  read that table and already knows `SESSION_SECRET` can confirm a guess of a secret; nobody else learns anything.
  Plain values are scrubbed of URL credentials and `key=value` secrets before they are stored, but a credential in a
  setting the descriptor does not mark as a secret and that the scrubber does not recognise would be shown to platform
  admins; the secret list is `FILE_VARS`, `S3_ACCESS_KEY_ID` and `OTEL_EXPORTER_OTLP_HEADERS`. Overrides are dual
  control (a second platform admin, never the proposer) and audited, but they move part of the configuration from the
  deployment into the database: whoever can write `platform_setting_overrides` directly (a database admin) changes
  the next start of every instance. Secrets, the database settings, `NODE_ENV`, `PLATFORM_SETTINGS_OVERRIDES` and
  `INSTANCE_NAME` cannot be overridden; set `PLATFORM_SETTINGS_OVERRIDES=false` to keep every setting in the
  environment. Hot settings are those the generator lists after reading their callers; one wrongly listed would need
  a restart to take effect although the screen says it applied. An instance that is down or not yet reporting cannot
  be compared, and stale rows age out after 24 hours.

- Storage (1.6.0, Sprint 35c, B-4204). The integrity check treats an object as referenced when any row anywhere names
  it, owns its directory, or has an id that appears in its key; that errs towards keeping objects, so a deleted row
  whose id is still in another row leaves its objects in place (they are not found as orphans). Objects younger than
  `BLOBS_ORPHAN_GRACE_HOURS`, backups and mirror files are never orphans. A dry run walks the references again and a
  deletion removes only the dry run's objects, within `BLOBS_DRY_RUN_MINUTES`; a row that starts naming one of them
  in that window (none of the server's writers reuse an old key) would lose its object. Checksums are first-seen
  baselines, not a manifest sealed at write time: an object changed before its first checked run is not detected,
  and a change through the store (which moves the modification time) is taken as legitimate, as is a change by
  someone who also resets the time. Missing objects are restored from a backup by hand (Platform › Backups); there is
  no per-object restore yet. Blob store migration copies with a SHA-256 check and dual writes while the copy runs, and
  waits for every live instance to confirm dual writes before copying; an instance that is not reporting (stopped,
  or started from an older build) would write only to the old store, so the migration fails rather than copy when a live instance
  has not confirmed in time, and an instance started later reads the shared mode before it serves. The `exprsn-ai`
  command line follows the shared mode too, but a restore into an empty database has no mode to follow and uses the
  store the environment names, so after a migration update `BLOB_STORE` and its settings in the environment. The quarantine's Rescan re-queues the existing scan jobs and Delete removes held
  bytes; neither releases anything without a clean scan.

- Blob deduplication (1.6.0, Sprint 36b, B-4601). Identical content is shared only within one tenant: the lookup is
  keyed by tenant and SHA-256, and each tenant's content is sealed with its own key, so deduplication across tenants
  is deliberately not done (it would need content encrypted under a key derived from the content, which lets anyone
  who can guess a file confirm that a tenant holds it, and would tie one tenant's deletion to another's object).
  Within a tenant the usual side channels of deduplication are closed as far as they reach a user: every upload
  stores and scans its full bytes (no faster or smaller upload for known content), the shared object is chosen only
  by the scan job afterwards, the quota counts each version's own size, and nothing a member sees says that a version
  is shared; only platform admins see the savings on Storage, per tenant, and `file.version.ready` names the blob in
  the audit chain. A tenant's database rows reveal which of its versions have the same content (they did before, by
  `sha256`). A shared object keeps the content key and associated data of the version that first stored it; deleting
  that version leaves the object to the others, and the object goes with its last reader. An object whose last
  reference is being released is never adopted (the count is only raised while above zero), but a version could
  adopt an object an operator deleted by hand outside the server; the integrity check reports that object missing for
  every version reading it, and one restore brings them all back. Versions stored before 1.6.0 share only from the
  first ready copy of each content onwards; older duplicates keep their own objects until they are deleted.

- Held form values (1.6.0, Sprint 36b, B-4701). A public submission with a held value waits, its screened values
  sealed with the tenant key and AD `app-form-hold:<id>`, until a reviewer (`flags:review` or `moderation:review`, in
  the app's workspace and cleared for the entity's label) accepts or rejects it; the values are dropped at the
  decision and the row is deleted `APPS_HELD_KEEP_DAYS` later. The submitter learns that the submission was held
  (`202`), which tells an anonymous visitor that some rule matched, as a refusal did before. At most
  `APPS_HELD_MAX_PER_FORM` wait per form, so the queue cannot be flooded past the per-address and per-form limits; past
  it a held value is refused. The submitter's address is kept only as an HMAC (with `SESSION_SECRET`), and in the
  `app.form.held` audit entry as every public submission's is. Accepting writes the record exactly as an unheld
  submission would (by no one), so the reviewer's decision, not their permissions, is what lets it in; the entity's
  validation runs at that moment. Signed-in submissions are still refused on a hold (the person can edit and resend).

- Reveal anomalies (1.6.0, Sprint 36b, B-4803). Detection informs, it never refuses: a stolen session revealing a
  secret still gets the value, and the owner learns about it afterwards (by notification and email) to rotate it.
  Only reveals over the API carry an address and are watched; values the server resolves for `vault:` references
  (workflows, connections, user stores) are not, and neither are transit decryptions or dynamic database credentials.
  The address is the one the server sees after `TRUST_PROXY`, so behind a proxy that is not trusted every reveal
  comes from the proxy and new-address detection is blind. Odd hours are hours of the day in UTC, learnt from the
  secret's own reveals once it has `VAULT_ANOMALY_MIN_HISTORY` of them; a secret revealed rarely never has odd hours.
  A burst is counted per principal and secret, so a caller spreading reveals across many secrets, or under the
  threshold, is not flagged; an attacker who first reveals from the owner's usual network is not new. The history
  holds addresses for `VAULT_ANOMALY_HISTORY_DAYS`; it is readable by the owner and vault administrators through the
  flag's detail and dropped by `vault.reveals.prune`. A flag on a secret without an owner or creator goes to no one but
  vault administrators.

- SCIM 2.0 provisioning (1.6.0, Sprint 37c, B-7201, B-7202). A SCIM token is a bearer secret for one store with no
  sender binding (no mTLS, no DPoP): anyone holding it creates, changes and deprovisions that store's users and their
  group memberships, which through group mappings means their roles, clearance and workspaces (never more than the
  mappings name: a SCIM store cannot give a role no mapping names, and it never takes over a user of another store).
  Tokens are shown once, kept as an HMAC with `SESSION_SECRET` (rotating it invalidates every SCIM token, as it does
  API keys), expire after `IDENTITY_SCIM_TOKEN_MAX_DAYS` and are revoked under Identity; the rate limit is per address
  (`IDENTITY_SCIM_RATE_PER_MINUTE`), not per token. Failed token checks are not written to the audit chain (no tenant
  is known yet); use the access log. Complex filters are evaluated in memory over at most 50 000 users or groups of the
  store; one `eq` on an indexed attribute is asked of the database. Deprovisioning ends what can be ended at once
  (sessions and their sockets, OAuth refresh tokens, API keys, DAV app passwords); an OAuth access token already issued
  to another relying party stays valid until it expires (at most its lifetime, 5 to 30 minutes) unless that party
  introspects it, as for any disabled user. Sign-in for SCIM users goes through the upstream stores the SCIM store
  names, matched by username: an upstream store whose usernames are not the provider's `userName` (Entra ID's UPN,
  Okta's login) does not link, and an upstream store an administrator names that belongs to another provider would let
  its accounts with the same names sign in as the SCIM users, so name only the stores of the same provider. The
  conformance runs of the Entra ID SCIM Validator and Okta's SCIM test suite could not be made from here (they call
  the service from the internet); `server/test/sprint37c-scim.test.ts` reproduces their checks locally
  (`docs/identity.md`).

- Vault sharing (1.6.0, Sprint 37c, B-4801). A share is an ordinary allow grant of `read` and `list` on one exact KV
  path, so it widens who reads that secret by design, within what the policy allows: a deny that names the grantee
  still wins, and the secret's label still has to clear the grantee's clearance. Sharing with a directory group or a
  workspace reaches whoever is in it at read time, including people who join later; share with a person when that
  matters. Whoever may share (holders of `secrets:write` with `read` and `write` on the path) may share with any
  principal of the tenant, without a second approval. An expired share stops applying in the same instant (the policy
  query compares the expiry), and is removed by `vault.shares.expire` within five minutes. A grantee who read the value
  keeps what they read: revoking a share does not rotate the secret. Reveals by grantees are audited and watched for
  anomalies (B-4803) like the owner's.

- MongoDB leases (1.6.0, Sprint 37c, B-4802). MongoDB accounts carry no expiry, so a leased user exists until the
  sweeper drops it (every `VAULT_LEASE_SWEEP_SECONDS`, 60 by default) or a revoke does; between the lease's expiry and
  the next sweep its password still works (PostgreSQL's `VALID UNTIL` closes that window there, MySQL has the same gap).
  The expiry is recorded in the user's `customData` for operators. Ending a dropped user's open sessions needs
  `killAnySession`, which `userAdmin` does not include: without it, sessions opened before the drop run until they
  close. The admin login is checked for `createUser`, `dropUser` and `grantRole` at registration, not for
  `killAnySession`. Connections use one direct connection to the checked, pinned address (no replica-set discovery);
  `mongodb+srv` is not supported.

- Quote posts and visibility (1.6.0, Sprint 37c, B-4901). Unlisted means out of feeds, not secret: anyone who may read
  the post's workspace or group and has its link (or its id, a ULID that encodes its creation time) can open it, and a
  bookmark keeps it listed for whoever saved it. Moderation, the flag queue, search over the audit chain and exports
  treat unlisted posts like any other. `public` changes nothing inside the instance (D4: there is no public feed); it
  only marks posts an author lets the 1.7.0 cross-posting (B-11402) write elsewhere. A quote may sit in another
  workspace than what it quotes: readers there who cannot read the quoted post see the quote without the embed, but its
  author's own words about the quoted post are theirs to share, under the guardrail and the quote's label (at least the
  quoted post's).

- WebDAV for the file store (1.5.0, Sprint 34b, B-3201 to B-3203): `/dav/files/` (the WebDAV URL Settings shows)
  answers only an app password with the `webdav` scope and the caller's `files:read` / `files:write`; a CalDAV- or
  CardDAV-only password gets `403` there. A PUT waits for its scan (run in the request on the database queue, up to 30
  seconds for a BullMQ worker); a scan that does not finish in time leaves the file unreadable until it does, and the
  client sees a success without an ETag. Finder's AppleDouble and `.DS_Store` files are accepted and discarded rather
  than stored. Locks are advisory to the API: the console and `/api/files` do not check WebDAV locks. Range requests
  are not supported (whole files only). MOVE across workspaces is refused. Real client traffic (Finder, Windows,
  DAVx5) is not yet replayed in CI; litmus is.

- Profiles and presence (1.5.0, Sprint 34c, B-5801, B-5802). A profile is known only to people who share a workspace
  with its owner; pronouns, bio and avatar further need the viewer's clearance to reach the profile's label and, when
  the owner narrowed it, a shared workspace among those named. Two people in a block see each other's name only, the
  same view a narrowed profile gives, and no presence. Pronouns and bio pass the `user-input` guardrail. An avatar is a
  file-store upload and goes through its quarantine; only a ready image version that is not in the trash and whose
  label the viewer clears is served, with the sandbox CSP and `nosniff`. Presence is decided by the server: a socket
  asks to watch people and joins only the presence rooms of those it may see; each change is published with everyone
  in a block with the person left out, so every instance relays the same filtered event, and a new block takes each
  person out of the other's room at once. Gaps: presence visibility follows shared workspaces only (not the profile's
  label or narrowed workspaces), so someone who sees a name-only profile still sees the status; idle is what the
  console reports (a client could keep reporting active); the bio is stored as written (after the guardrail), not
  sealed, like the display name; a chosen status has no expiry; the avatar's file stays in the uploader's workspace
  file tree, where workspace members can see it as a file like any other upload.
- The chain context and Workflows 2's sub-workflow, agent, map and loop steps (1.5.0, Sprint 32, B-4101, B-3901,
  B-3902, B-3905). The chain covers what runs on this server; what leaves it (a webhook receiver or an MCP server that
  calls the API back) starts a new chain, bounded only by its own rate limits. A chat turn is a chain node only when its
  answer calls a registry tool, and the chat model's own tokens are metered per conversation, not charged to the chain.
  Plugin event fan-out still carries its own chain of plugins (`PLUGIN_MAX_DEPTH`); only a plugin action that starts a
  workflow is a chain node (the root of a new chain), so an agent → event → plugin → workflow path is two chains. An app
  trigger owned by someone else than the chain's principal starts a chain of its own (it acts as its owner). "Cost" is
  metered as GPU time; chains are not priced against the price books. Wall time is charged for leaf work only, so time a
  run spends waiting on an approval is not counted, and a child executed inside its parent's step counts its own steps;
  budgets are checked before each step, so the step that crosses a budget completes. A pending workflow tool's call node
  stays `waiting` until the awaiting agent picks its result up. Skills on a model step: at most six rounds of tool
  calls. Map items never pause one by one; a write tool in a map or loop needs an Approval step before it. A child
  workflow runs inside its parent's step while it can, so a long child counts against the parent's step timeout.
- Chaining across kinds (1.5.0, Sprint 34a, B-4102 to B-4107). Cross-kind cycles are now checked at publish (B-4105),
  but only a cycle made entirely of steps that always run (sub-workflows, map and loop workflows, agent steps, skill
  loads, a workflow tool's workflow) is refused; a cycle through a model's choice (an agent's delegates, listed
  workflows or tools, which includes an agent delegating to itself) is published with a warning and bounded at run time
  by `CHAIN_MAX_DEPTH`, `AGENT_MAX_DEPTH` and the root's budgets. Branches are not followed, so a sub-workflow cycle
  behind a branch that would end is refused too. The graph is built from what is published now and checked when
  something is published, from it: a later change elsewhere that closes a cycle is caught when that change is
  published. References resolve tenant-wide (a workflow in the entry's own workspace); an entry published only to
  other workspaces passes the check and is hidden at run time. A delegate's budgets are clamped to what the delegating
  run has left when it starts, and its tokens are added to the delegating run's afterwards; its steps and wall time
  count only at the root. A held call is decided where it waits with that place's rules; the chain view itself is for
  the chain's principal and agent, tool and workflow admins, so another approver decides from the place, or through
  `POST /api/chains/:id/held/:node/decision`, which answers `404` unless they may decide the call. A model step's held
  call keeps the conversation so far sealed in the step until it is decided; the approved call passes the `tool-call`
  checkpoint again when it runs. The audit `target` filter is a `LIKE` over the target JSON within the tenant (no index
  of its own). The chain view lists at most 50 guardrail decisions and 20 audit entries per run. A replay from a node
  is a new chain, not a branch of the old one.
- Feed generators and relay commit verification (1.5.0, Sprint 31, B-3001 to B-3003, B-3604). Relay commits are
  verified one at a time in the consumer's order: each repo DID new to the cache costs a DID resolution (up to five
  seconds), so a subscription to the whole network over subscribeRepos falls behind where a Jetstream would not; use
  author allow-lists. A DID that cannot be resolved, a `tooBig` commit and an operation whose tree nodes are missing
  from the CAR are dropped, not retried. Commit `rev` order and `prev`/`prevData` chaining are not checked (a relay
  could replay an old, validly signed commit), and `#sync` and `#account` frames are not acted on (a deactivated or
  taken-down repo's posts are still taken until its relay stops sending them). Feeds index only what the firehose
  subscriptions take (their collections, authors and sample) and what passed the moderation check; a post without text
  is never indexed. Keyword matching is on the post text at ingest only; changing keywords or the ranking empties the
  index, which refills from new posts (there is no backfill). A ranked feed orders by score alone, so an old post with
  a high score stays at the top until its retention runs out. Rankings call the gateway for every post that passes the
  rules (two embeddings per post: the query's is cached per feed version), without tenant quota metering. The service
  JWT's `jti` is not remembered, so a captured token can be replayed until it expires (at most an hour); the viewer's
  DID is not used for personalisation and not stored. A feed's rules and index are not labelled: feeds are built from
  public AT-Protocol posts and served publicly, and any `firehose:manage` holder manages every feed of the tenant. A
  feed is named, until B-3004 records its publication, by any `at://` authority with its record key. The feed
  generator needs the tenant's own identity; the platform identity serves none.

- The AT-Protocol PDS (1.5.0, Sprint 31, `docs/pds.md`): what a hosted repository holds is public by protocol and
  served to anyone, including relays and AppViews that keep copies Exprsn-AI cannot withdraw; a takedown stops this
  PDS serving the repo and publishes `!takedown`, but copies elsewhere remain until their operators act on the label
  or the `#account` event. Hosting is off by default and enabled per tenant by a platform admin. Each commit rebuilds
  the repo's Merkle search tree from its record list (canonical by construction, and checked against the interop
  vectors), so the cost of a write grows with the repo's size; very large repos (hundreds of thousands of records)
  write slowly. The repo's blocks are stored as base64 in the database, not in the blob store. Record content is not
  sealed at rest (it is public, and the commit signature covers its exact bytes); blobs are sealed like files. Records
  are not run through the guardrails or the moderation check when written: moderation acts on reports and on the
  repo as a whole (`pds-repo`), not record by record, and labels from other labelers are not applied to what the PDS
  serves. Sessions come from app passwords only; the Exprsn-AI password is never accepted over XRPC, and there is no
  OAuth sign-in to the PDS, no email confirmation or password reset over XRPC, no `app.bsky.*` proxying to an AppView
  and no preferences, so Bluesky clients that read timelines through their PDS need the AppView configured on their
  side. Access tokens are HS256 under a key derived from `SESSION_SECRET` (rotating it ends every PDS session). Handles
  live only under the tenant's subdomain of `PDS_HANDLE_DOMAIN`, resolved over HTTPS (the operator's wildcard DNS); a
  tenant's own domain waits for 1.6. `createAccount` creates the Exprsn-AI user before the AT-Protocol account, so a
  PLC directory that fails at that moment leaves a user without a PDS account (they create it from the console). The
  move code for `signPlcOperation` is shown in the console instead of emailed. Blobs are typed from their first bytes
  (PNG, JPEG, WebP, GIF, MP4) and scanned by ClamAV when configured; a video's content is not otherwise inspected. The
  interop run against the reference AppView (`interop/run.ts`, the CI `interop` job) uses `@atproto/dev-env`, which
  has no separate relay: the AppView reads the PDS directly, and the relay side is covered by the relay double.

- Model-based memory management (1.5.0, Sprint 30): the tenant's memory profile reads the user's chat messages and
  agent runs' tasks and answers (through the gateway, within the profile's label and the pool's ceiling). The text is
  sent as JSON data with an instruction to treat it as such, and only a strictly valid JSON answer is used, but a
  message can still steer the model into proposing a memory its author chose; the defence is that every proposal
  passes the `memory` checkpoint and the credential ban and waits for a person. The profile's answers do not pass the
  `model-output` checkpoint (each proposal passes the `memory` one instead), and its calls (extraction and
  consolidation judgements) are neither admitted against nor metered in the tenant's quotas; embeddings are metered as
  before. The rejection list compares one-line, lower-case text, so a paraphrase of a rejected memory can be proposed
  again (a rejected merge pair is not judged again). Consolidation compares up to 300 memories per owner and judges at
  most 50 pairs per run, in the job's process memory; larger sets are consolidated over several runs. While a reindex
  runs, the whole tenant's recall is by recency; if it fails it stays `failed` (retried up to three times) and recall
  uses only the vectors already made with the model in effect, until `POST /memory/reindex` succeeds.

- CalDAV and CardDAV (1.5.0, Sprint 30, `docs/dav.md`): DAV clients authenticate with HTTP Basic and an app
  password, so the password crosses every request (over TLS; plain HTTP is refused when `COOKIE_SECURE` is set, but a
  deployment without it accepts Basic in the clear). A DAV request counts as MFA-verified because the app password was
  created after a fresh second factor; it is narrowed to DAV scopes and never accepted by `/api`, `/v1` or the
  console. Failed attempts are limited per address and per app password in the shared counter store, not by the
  account lockout table. Group calendars and the directory are views without a change log: their sync tokens refuse a
  removal they cannot name, so clients re-fetch the collection then. A time-range query on a recurring object is
  inclusive (the span of all its instances), and a non-IANA TZID is read with its VTIMEZONE's standard offset.
  Directory entries carry their person's clearance as their label; the directory lists the tenant's active users
  who share a workspace with the caller (all of them when the caller is in a workspace open to the whole tenant),
  within the caller's clearance (owner's decision, 2026-10-05). The conformance fixtures were written from the
  clients' request formats, not captured from devices, so B-3104 counts as partial until real traffic from Apple
  Calendar and Contacts, Thunderbird and DAVx5 is captured and replayed (owner's decision, 2026-10-05). That capture
  (B-3606) was dropped by the owner on 2026-10-06 (not needed); it had been held because macOS 27 Calendar refuses Basic authentication over plain HTTP, and capturing
  over TLS needs a per-host certificate trust on the capturing Mac that was not approved.

- Import repositories and model import (1.5.0, Sprint 30, B-3801 to B-3803): the allow-list is enforced by the
  platform's own egress (each hop of a redirect checked, credentials never forwarded along one); with
  `IMPORT_PROXY_URL` the connection is the proxy's, and the proxy must enforce the exported allow-list itself
  (`GET /api/imports/proxy-allowlist`): the platform cannot check the addresses the proxy dials. Hugging Face gates that
  the publisher approves by hand stay pending; the platform only sends the access request with the recorded token and
  records the acceptance once a file is readable. The licence is read from the model card at the pinned commit or the
  Ollama license layer and recognised from a fixed list; a card that misstates its licence is recorded as stated (legal
  review sees the source in the manifest). Staged weights are kept unsealed and content-addressed under
  `imports/blobs/` (public repository content; the copies handed to the training worker are sealed per tenant), and
  nothing expires them yet. Ollama registry imports pin the manifest digest and stage the layers, but the pools still
  pull the tag from the registry their Ollama is configured for (the registry itself, or an internal mirror): the
  platform does not serve the staged layers to Ollama, and on an air-gapped instance the pools need the bundle's
  models in that mirror. Speech, image and other non-Ollama models are refused; text-classification models are
  served by the classifier worker when one is configured (below). Repository
  credentials resolve as the user who saved them (B-1705), so that user needs `secrets:read` and the vault path; a
  model admin without vault access records repositories without credentials. DCAT-AP, SDMX and OpenML have no search
  API, so they browse their snapshot only; OpenML licences are read for the first `detailLimit` datasets of a harvest.
  Imported classifier engines (1.7.0, Sprint 40, B-3806): a text-classification model is served by the classifier
  worker (`CLASSIFIER_WORKER_URL`, `docs/classifier-worker.md`), which holds only the files the server pushed after
  the import verified them, checks each hash and the model digest before every load, loads safetensors only and
  runs no code from a repository. The texts a classifier scores go to the worker in plaintext over that connection
  (TLS when the URL is https; a bearer token when `CLASSIFIER_WORKER_TOKEN` is set), bounded by the model's label
  and `CLASSIFIER_WORKER_LABEL_CEILING`; the worker is not a pool, so zones do not apply to it. A worker without a
  token on a loopback address answers any local process. Calls are not metered or queued: there is no slot limit, and
  the evaluation job scores one text a call. A draft classifier may be tried and measured on a model that is not yet
  approved (by `classifiers:manage` holders); publishing needs the approval. A model's labels are taken as published
  (`LABEL_0` stays `LABEL_0`): there is no mapping onto other label names, so an eval set must use the model's.
  Token-classification, zero-shot and multi-task heads are not served. The staged files stay in the blob store for
  re-pushing and nothing removes them from the worker when a model is retired. Air-gapped bundles carrying a
  classifier model follow the same job but have no test.
  Dataset import (1.7.0, Sprint 40, B-3804 to B-3806): rows are fetched with the same fetcher and allow-list. The
  dataset viewer of a hub never receives the repository's token, so gated datasets are refused. The whole selection
  is held in memory while it is scrubbed (bounded by `IMPORT_DATASET_MAX_ROWS` and the tenant's quota). A `store`
  import keeps the rows as published, sealed but not scrubbed. A knowledge set's refresh builds the next
  index version beside the serving one and swaps it in with one transaction (migration
  `052_knowledge_index_versions`); the copy of unchanged chunks opens each and seals it under its new id, and staged
  documents are out of search, the documents list and the counts until the swap. A base has one building version at a
  time, so a refresh fails (and is tried again the next day) while a rebuild or another source's refresh is building,
  and a rebuild is refused while a refresh builds. The pgvector path of the vector copy has no test. Quota is what the imports hold (`import_jobs.stored_bytes`);
  withdrawing a training version or removing a knowledge source does not give it back yet. The PII flags of the schema
  preview are the deterministic detectors and column-name rules, not a model. The fetch steps of Kaggle, e-Stat and
  the OGD platform, and of a gated hub dataset's Parquet files, are tested against local fakes written from the
  services' documentation, not against the services. e-Stat and the OGD platform take their key in the query string,
  so it is in the address of every request to them (never in a stored address, and struck out of errors); a proxy
  between the server and those hosts that logs addresses logs the key. A zip archive, a workbook, a Parquet file or an
  XML document is held in memory whole (IMPORT_ARCHIVE_MAX_BYTES, and IMPORT_ARCHIVE_MAX_UNPACKED_BYTES unpacked);
  Zip64 archives, archives inside archives and `.xls` are not read. The Parquet reader (`hyparquet`) is bounded by the
  sizes the file's footer and page headers state, checked before a page is unpacked, but a file written to mislead it
  about value counts has not been fuzzed. A Kaggle repository needs `storage.googleapis.com` on its host list, which
  admits any address on that host as a redirect target of that repository. An air-gapped instance has no dataset
  import. Imported classifier engines (the second half of B-3806) are not built: there is no classifier worker.
- Permission matrices and custom roles (1.5.0, Sprint 29): custom roles are the tenant's; a workspace cannot define
  its own (the open decision in `Backlog-1.5.0.md` is settled that way for now). The roles in force are held in each
  instance's memory and reloaded through the bus when they change, so an instance without `REDIS_URL` sees another
  instance's change only after a restart (as for every bus-driven cache); a single instance applies it at once. The
  route registry checks the `requireAuth`, `requirePermission` and `requireAnyPermission` middleware only: a route
  declared `authenticated` or with a permission its handler checks itself is taken at its word, and conditions a
  handler adds (ownership, membership, clearance) are not in the table. Workflow approval steps and low-code state
  machines still name built-in roles only. Access reviews cover direct grants; roles and memberships from group
  mappings or the directory are reviewed at the mapping, since a removed row would come back at the next sign-in or
  sync. Reviewers are assigned per item (the grant's admins and the member's directory manager); the manager comes
  only from LDAP stores (`managerAttribute`) and SQL user tables (`columns.manager`), and only when the manager is a
  user linked to the same store (matched on the external id, ignoring case but not spacing within a DN); upstream
  OIDC and SAML claims, SCIM and the local store carry none, so their members are reviewed by admins only. Workspaces
  have no admin role of their own: a workspace's admins are the tenant admins and its members holding `roles:manage`.
  A grant whose only possible reviewer is its member (a sole tenant admin reviewing their own membership) stays
  unassigned to anyone else but the campaign's creator, and is escalated when overdue. A review does not snapshot API keys: a key's scopes only narrow its owner's roles, so revoking the role is
  enough. The effective-access matrix shows at most 100 workspaces and 100 users per answer, and its cells are the
  policy decision only: `member` says separately whether the user may act in the workspace.

- First-factor enrolment: `admin:create --enrol-link` (1.2.0) gives the first admin a single-use link that sets the
  password and opens a session that can only enrol a second factor, so that account is never usable with a password
  alone. Admins created with a password (the CLI without the flag, or by an identity admin in the console) still enrol
  their factor at first sign-in and are protected by the password until then; have them sign in and enrol promptly.
- Guardrails: while an answer streams, the deterministic `model-output` rules screen it sentence by sentence and the
  guard-model and classifier rules check the text so far in the background (Sprint 16). With
  `CHAT_GUARD_HOLDBACK_SENTENCES` ≥ 1 (the default) a sentence is shown only after a clean verdict covers it; with 0
  it is shown at once and a verdict can only stop what follows, so text the guard model would block can be shown and
  is replaced afterwards. A background check that cannot run stops release; the rest is shown after the full check.
  Thinking is screened like the answer, and since 1.3.0 the full check on the finished answer covers the thinking as
  well: thinking it blocks or holds is withheld (the answer itself is decided by its own check), and thinking already
  shown while streaming is replaced when the client reloads the answer. A phrase that spans a sentence boundary is
  blocked when its second half arrives, but the first half may have been shown. Tool results shown in chat pass the
  same screen (the model still receives them, checked at `context`). A `require-approval` on the prompt (`user-input`)
  holds it for a reviewer in chat and compare (every column waits), and holds a `/v1` request sent with an API key
  (`202`, then `GET /v1/held/:id`); a hold that comes from a check that could not run still refuses the turn, and a
  `/v1` request sent with an OAuth access token is still refused rather than held (the token could expire or be revoked
  while a reviewer decides). An approved `/v1` request runs as its sender with the key's scopes at approval time; a
  revoked or expired key, or a disabled owner, fails it. The request and its answer are kept sealed in `api_holds`;
  there is no retention period for held API requests yet.
- The trained classifier is a hashed-word linear head: its precision and recall are only as good as each tenant's
  labelled cases (the console warns below 200 per label).
- Knowledge: row-level access for database sources comes from an access column the curator names (groups or users per
  row) or, for PostgreSQL (Sprint 23), from the database's own row security: the source reads as one mapped role per
  group, and a policy change applies at the next sync (sources sync on their schedule, not when a policy changes).
  Role-mapped sources read the whole object per role (up to 5000 rows each) and cannot replicate. Groups are matched
  against the groups the user's identities carried at their last sign-in or directory sync, so a change in the
  directory applies from then. The crawler and buckets on their own endpoints reach internal hosts (and those in
  `KNOWLEDGE_ALLOWED_HOSTS`) with every dialled address checked; the crawler has no authentication (a site that needs
  a login cannot be crawled), does not run JavaScript, and indexes what any internal client could fetch, so the
  source's label floor must reflect the site. A crawled page or image is outside content: it is indexed as it is served, an image's caption and text are what a vision model made of it, and a recorded change holds the text a page had before (sealed, kept with the source, at most 1000 a source), so naming a public host in `KNOWLEDGE_ALLOWED_HOSTS` is a decision about trust in that site. Rows the reader may not see are dropped after ranking candidates, so a result list can be shorter than
  asked. Logical replication (PostgreSQL tables with `pgoutput`) needs `wal_level=logical`, a publication the database
  owner creates and the REPLICATION attribute on the connection's account; replicated changes are applied as they
  arrive (no back-pressure beyond one transaction at a time), and a delete is matched by the id column only when it is
  the primary key or the table has `REPLICA IDENTITY FULL`. A slot whose stream stops keeps WAL on the database until
  the stream resumes or the source is removed (which drops it). Views and MySQL sources sync by watermark. A
  citation's passage is chosen by word overlap with the answer (the best-matching sentences of the chunk), not by the
  model saying what it quoted.
- Data connections: PostgreSQL, MySQL and OpenSearch; a username and password sealed with the tenant key, or (SQL
  engines) OpenBao dynamic database credentials. Dynamic leases are held per instance and revoked when a connection
  is removed, its credential changes, or the instance shuts down cleanly; an instance that dies leaves its lease to
  expire at its TTL. Writes through a connection are refused outright. Hosts must be internal unless
  `CONNECTIONS_ALLOWED_HOSTS` names them; a failed test still reports reachability for internal addresses. The MySQL
  classifier refuses vendor syntax it cannot lex safely rather than asking for confirmation.
- MongoDB connections: read-only rests on the query model (only `find` and `aggregate` with allow-listed stages, no
  `$where`, `$function`, `$accumulator` or Code values, re-checked by the driver) and on the account; MongoDB has no
  read-only session the way PostgreSQL and MySQL have a read-only transaction, so an account with the `readWrite` role
  is only reported (`degraded` on Test connection), not prevented. Use an account with the `read` role. The driver
  dials one server directly (no replica-set discovery or SRV records), so a connection names one member; there is no
  per-connection CA file for TLS (the system trust store, plus `NODE_EXTRA_CA_CERTS`, as for the other engines). The
  schema is sampled from the first documents of each collection, so the tree and convention-based PII masking only
  know the top-level fields seen there; values the classifier recognises are masked anywhere in a document. A
  knowledge source's watermark is compared with `$gt` as each type its text can stand for, and documents sharing the
  last watermark value with a later insert can be missed, as with the SQL watermark. A source added without `fields`
  indexes the text fields seen in that sample, so a text field that first appears later is not indexed until the source
  is added again with it named. Admin-marked PII paths inside sub-documents (`tickets.customer.email`) are masked when a
  knowledge source names that path, not inside a whole sub-document returned by a query (there only field names like
  `email` and values the classifier recognises are masked). OpenBao dynamic credentials do not apply to MongoDB.
- With `REDIS_URL` set, rate limits, the failed-bearer throttle and the denial cap are shared by every instance; while
  Redis is unreachable (and without it) they are counted per instance, so a caller spread across N instances gets up
  to N times each limit. Since 1.3.0 an outage is visible: each instance probes Redis every `RATELIMIT_PROBE_SECONDS`,
  the Platform screen warns, and `exprsn_ratelimit_degraded` drives the `ExprsnRateLimitsPerInstance` alert; the limits
  themselves are still per instance until Redis answers. The failed-bearer throttle is per address: clients behind one
  NAT share it.
- Scripts need docker or podman on the host; with `SCRIPT_RUNNER=none`, or when no runtime answers, runs are refused.
  The sandbox relies on the container runtime's isolation unless `SCRIPT_RUNTIME=runsc` puts containers under gVisor
  (the host must have it installed and registered with the engine); there is no Firecracker option.
- Tools: in chat, the model is offered only read-only tools that need no confirmation. Since 1.7.0 (B-4003) a person
  may call a write or destructive tool from the composer: it waits on an approval card that shows the tool, its
  side-effect class and the exact arguments, runs only on the caller's own approval (and a reviewer's, in the Flags
  queue, when a `tool-call` rule holds it), and a card decided later runs only the entry it showed, unchanged. The
  model still cannot propose such a call in chat (B-4006 is not built); agent runs and workflows provide that. MCP servers are checked against internal addresses after DNS
  resolution; hosts in `MCP_ALLOWED_HOSTS` (never link-local) are trusted by the operator. Tool results pass the
  `context` checkpoint (`meta.via: tool-result`) before the model sees them: a block withholds the result (the call
  itself has already run), a redaction replaces it. Agent runs propose memories only through the `remember` tool
  when their definition allows it; a model without tool calling cannot propose any.
- Workflows: the HTTP step may call any private address (narrowed by `WORKFLOW_HTTP_HOSTS` and by the tenant's
  allowed hosts when they are set) and, since 1.7.0 (B-9101), any public host the tenant's list of allowed hosts
  names: one list per tenant, shared with HTTP tools and webhooks, not one per workflow, and `WORKFLOW_HTTP_HOSTS`
  does not narrow public hosts. An HTTP step's answer is not marked as untrusted content for a later model step.
  The check for literal credentials in a step (B-9102) goes by the names of headers, query parameters and body
  fields and by a few well-known token shapes; a credential under an unremarkable name, or in a body that is neither
  JSON nor a form, is not recognised. A version stored before the rule keeps running with its literal until it is
  saved again. Run events go live to the person who started the run and to the holders of the
  approval roles it asked for. A workflow published as a tool is pinned to one version and cannot be called from
  another workflow; when it pauses for an approval an agent run awaits it, but chat and the registry test harness get
  an error while the run continues on its own.
- Images and media frames are checked by the classifier at `IMAGE_SAFETY_URL`; without one, images are marked "not
  classified" rather than blocked unless `IMAGE_SAFETY_REQUIRED` is set, which withholds them (the default is off, so
  a platform without a classifier still generates images).
- Resumable streams: an answer is marked interrupted only after `CHAT_STREAM_LEASE_SECONDS` without a heartbeat, and
  the stored text is the last snapshot (up to two seconds behind what clients saw). Continuing it relies on the
  model carrying on from an assistant prefill, which Ollama supports but a model may phrase imperfectly. An answer
  interrupted before its full `model-output` check ran shows what passed the streaming screen until it is continued
  or regenerated. Without Redis the catch-up buffer lives in the database; running several instances still needs Redis
  for the bus and the socket adapter.
- Conversation retention deletes conversations by last activity; the shortest of the tenant's, the workspace's and
  the owner's periods applies (Sprint 16). Periods are set by tenant admins; users cannot set their own. Usage
  records, audit events and flags that quote a purged answer are kept under their own rules.
- Training (worker contract 2, [training-worker.md](training-worker.md)): rows travel encrypted and the run key is
  released once, but the worker necessarily holds the decrypted rows (and the key) in memory or scratch for the run;
  run it inside the training zone with encrypted scratch that it clears. Checkpoints and GGUF files uploaded to the
  platform are sealed under the tenant key; the worker is trusted to delete its local copies. A checkpoint read back
  is streamed before its GCM tag is checked at the end (a failing read is cut off, not completed). The draft model's
  GGUF is still pulled by name from the registry the worker pushes to; the gateway does not import a GGUF file
  directly. The client-certificate check relies on the proxy that terminates mTLS when the server does not.
  `TRAINER_PLAINTEXT_FALLBACK` brings back contract 1 (plaintext rows) for an old worker.
- Zones: rendered Compose and nftables files are downloaded and deployed by an operator. NetworkPolicies are too,
  unless `ZONES_APPLY=kubernetes` (1.3.0): the server then applies each zone's policy with server-side apply after
  every approved change and reports drift (edited or deleted policies) on the Zones screen, in the audit chain and as
  an alert. It does not create the zone namespaces, does not delete policies of zones that are removed, and the drift
  check compares the fields it set (a field added by hand to an existing rule, without changing a list's length, is
  not noticed). The service account needs only get, list, create and patch on networkpolicies in the zone namespaces
  (the chart's `zonesApply` Role); its token is then mounted in the pod. MCP server and connection registration
  are refused in an undefined or external zone, or above its ceiling, only once zones are defined; members registered
  before that are listed on the Zones screen (and admins are told when the first zones appear), each with a move
  proposal that a second system admin approves. MCP servers carry no label, so only their zone is checked.
- Zones: seeding the default set is a single system-admin action (it can only add zones and never lowers what a zone
  holds); every later change needs a second system admin.
- Import bundles stream through verification and promotion (a 3 GiB bundle verifies with flat memory); S3 uploads
  use 16 MiB multipart parts, so one object is capped at about 160 GiB. Promotion writes into the mirror store in the blob store and,
  where a mirror has a push target, into Harbor (OCI image layout tars only; `docker save` archives are not
  converted), Verdaccio or devpi through their APIs. npm tarballs and wheels are read into memory to push (capped at
  512 MiB); image layers are streamed. The Trivy database, model weights, OS packages and OpenTofu providers are still
  left to each mirror's own sync from `mirrors/<kind>/`.
- Without `PLATFORM_TRIVY_BIN` or `PLATFORM_STAGING_URL` the scan and staging steps are recorded as "not
  configured" and a bundle can still be promoted unless `PLATFORM_BUNDLE_REQUIRE_CHECKS` is set. Adding and revoking
  signer keys is under dual control, except the very first key, which one platform admin registers (as with the
  default zone set); revoking a compromised key therefore also waits for a second admin.
- ACME: http-01, or dns-01 through a signed webhook or RFC 2136 (TSIG) dynamic update over UDP with a TCP fallback;
  external account binding when the CA requires it. When the zone is not configured it is taken from the SOA record,
  but updates still go to the configured server (the SOA's primary name is not followed). Issued certificates are
  written to `ACME_CERT_DIR` on every instance and can run push hooks (a reload command named by the operator, or a
  signed webhook that carries the chain); services that need the private key elsewhere still take it through the
  audited export.
- Backups cover the application database and the blob store; the KMS key material must be backed up with its own
  tooling, and a backup cannot be opened without the KMS key. The dump reads one snapshot and the blob archive holds
  exactly the objects the snapshot's rows name (plus the content-addressed mirrors and pipeline staging, which no row
  names, archived as listed); an object deleted while the backup runs is missing from it although its row is in the
  snapshot. Objects whose keys are derived rather than stored are covered by a fixed list (audit export parts, bundle
  transfers). With an in-memory SQLite database the dump holds the only connection, so other queries wait until it
  ends. The dump is logical (streamed, a page at a time). `backup:restore`
  restores into the configured database (tested on the engine the backup came from) with every instance stopped; it
  refuses a database with tenants, users or audit events unless forced with the confirmation phrase, and blob objects
  are written after the database commits. Tables outside the portable schema (`vectors_pg`) are skipped in the drill
  and rebuilt by reindexing.
- Clock skew is measured against the database server, and against NTP when `NTP_SERVER` is set. SNTP is
  unauthenticated (no NTS); since 1.3.0 `NTP_SERVER` takes several servers and the reported skew is the median of the
  ones that agree, with outliers named, so one lying or spoofed server no longer hides skew. An attacker who controls
  the path to most of the servers still can; it is a check, not a time source.
- Federation: the SAML IdP signs with RSA-SHA256 only: the assertion always, and the whole response too when the
  service provider is set to it. SP and upstream IdP metadata can be fetched from a URL (through the upstream host
  checks) and are refreshed every `FEDERATION_METADATA_REFRESH_HOURS`; a changed certificate or endpoint waits for an
  identity admin's approval, and metadata naming another entity ID is refused. Pasted metadata is never refreshed. Upstream SAML accepts only exclusive C14N with RSA-SHA256 or ECDSA-SHA256 over SHA-256 digests and
  refuses IdP-initiated responses; upstream SAML's browser binding needs HTTPS (a `SameSite=None; Secure` cookie).
  Encrypted assertions use AES-GCM with RSA-OAEP only (CBC and RSA 1.5 are refused, so an IdP that only offers those
  must send them unencrypted).
- Logout: front-channel logout relies on the browser loading the relying parties' pages in frames with their own
  cookies, which browsers that block third-party cookies prevent; back-channel logout does not depend on the browser.
  Signing out in the console (`POST /api/auth/logout`) reaches back-channel clients and, through the signed-out page
  it opens, front-channel clients and SAML SPs with a redirect-binding logout endpoint; SP-initiated upstream SAML
  logout still happens only at `/oauth/logout`. SAML SPs that only take HTTP-POST single logout are not
  told when another SP or a relying party starts the sign-out (their sessions end at their own timeout).
  `prompt=login` and `max_age` re-authentication sign the current session out first, which also signs the user out of
  that session's other applications.
- DPoP: server nonces (RFC 9449 section 8) are required only with `DPOP_NONCES=true` (off by default, so clients
  that cannot retry with a nonce keep working); without them a proof's freshness rests on `iat` within
  `DPOP_PROOF_MAX_AGE_SECONDS` and the single-use `jti`. Nonces are an HMAC of the time window, valid for one to two
  `DPOP_NONCE_SECONDS` periods on every instance. Set `API_PUBLIC_URL` when a proxy serves the API under another origin
  or path prefix, or DPoP-bound API calls fail the `htu` check.
- Token introspection: a client registered as a resource server (`introspect: any`, set under dual control) sees every
  client's access tokens in its tenant; refresh tokens introspect only for the client they were issued to.
- Kerberos needs the optional `kerberos` npm module (GSSAPI bindings) and a keytab on the host; it is not bundled.
  Mapping takes the principal's user part and looks it up in the tenant's user stores; realms map to tenants only
  through the per-tenant realm allow-list.
- Signing keys (Sprint 20): with `KMS_PROVIDER=local` and the signer process (`exprsn-ai signer`, `SIGNER_SOCKET`),
  the key-encryption key and the OIDC, SAML, SAML SP decryption and webhook Ed25519 private keys live only in the
  signer; the app stores opaque wrapped blobs it cannot open. Data keys are still unwrapped into the app's memory
  (content is sealed there). Node cannot read a UNIX socket peer's uid (`SO_PEERCRED`), so the signer does not check
  the caller's credentials: access rests on the socket directory and socket permissions (0700/0600, or 0750/0660 for
  a shared group) and a shared token every connection must present first; run the signer as its own user so the
  app's user cannot read the signer's key file. Anyone who can reach the socket with the token can have the signer
  sign or decrypt (it never exports a key). The signer signs the bytes it is sent (at most 512 KiB since 1.4.0, for CRLs; 64 KiB before), not a digest,
  because node:crypto cannot sign a precomputed digest with ECDSA or Ed25519. Without the signer, the local KMS keeps
  the federation and webhook keys sealed with the data keys and unsealed in memory while in use. With OpenBao, OIDC,
  SAML and webhook signatures are made in transit; the SAML SP decryption key is then still sealed locally (transit's
  RSA decryption does not offer the OAEP variants IdPs use). Turning on OpenBao or the signer replaces the signing
  keys at once (the old public keys stay published for the overlap): SAML service providers must re-import the IdP
  metadata, and upstream IdPs the SP encryption certificate (the replaced decryption key is still tried while it is
  published).
- Certificate authority (Sprint 24): issuer and OCSP responder keys are made and used only in the signer or OpenBao
  transit; with neither the CA refuses to make keys. Creating, rotating or re-issuing the root needs `platform:manage`
  and a recent sign-in, not a second admin (no dual control yet). Tenant intermediates carry no name constraints: a
  tenant admin with `pki:manage` sets their own profiles, so administrator issuance (the API and `exprsn-ai pki`)
  checks names against policy but not domain control; only ACME orders (Sprint 25) also prove control of each name
  (see the ACME paragraph below and `docs/pki.md`). Anyone who trusts the platform root trusts every tenant's
  issuance; trust a tenant's intermediate rather than the root where that matters. CRLs are full CRLs only
  (no delta, indirect or partitioned CRLs; no `certificateHold`), and a CRL's to-be-signed list is capped by the
  signer at 512 KiB (roughly 10,000 entries; expired certificates drop off). OCSP request signatures are ignored
  (no requestor is trusted), responder certificates carry `ocsp-nocheck` and are short-lived (`PKI_OCSP_SIGNER_DAYS`)
  instead of being checked, and answers are cached per instance: a revocation clears them on every instance through
  the bus, which needs `REDIS_URL` across instances. Issued certificates have a CN subject plus the attributes
  Certificates › Settings adds (1.9.0); other CSR attributes and extensions besides subjectAltName are ignored. Since
  1.9.0 setting changes to the root and intermediates are under dual control, but creating, rotating or re-issuing
  an issuer still needs one platform admin with a recent sign-in.
- CA settings, tokens and member certificates (1.9.0, Sprint 55): without Redis a saved setting reaches another
  instance when its 30-second cache goes stale. CA tokens are bearer tokens: anyone holding one may use it until it
  ends; there is no proof of possession (no DPoP or certificate binding). A persistent token lives until revoked or
  its signer's certificate ends (at most 398 days); refresh it before then. Offline verifiers see revocation only
  through the signer's certificate (CRL or OCSP), not per token. The key made for a member at join waits in the
  database sealed with the tenant key until it is picked up (a tenant-key holder could open it); a member who never
  picks it up still has a certificate whose key the server made. Certificate sign-in trusts the proxy listed in
  `PKI_CLIENT_CERT_PROXIES` to have verified possession of the key; any process that can reach the app's port from
  that address can claim a certificate (bind the app to loopback or a private network). Member certificates are the
  only client certificates that sign in (other client certificates of the CA do not).
- ACME server (Sprint 25, B-1605): each tenant's directory is unauthenticated by design (the JWS signatures and the
  challenges are the authentication), rate-limited per address and closed until a tenant admin opens it. Orders are
  bounded by the directory's server profile and every name is proven by http-01 or dns-01; every object is stored
  and looked up by tenant and owning account. Limits: dns identifiers only (no IP identifiers, RFC 8738), no
  `notBefore`/`notAfter`, no authorization reuse across orders (each order validates its names again), no
  pre-authorization (`newAuthz`), no ACME Renewal Information (RFC 9773), and one validation attempt per challenge
  from one vantage point (no multi-perspective validation): an attacker who controls the path between Exprsn-AI and a
  name's server or resolver can obtain a certificate for that name, within what the profile allows. http-01 follows
  redirects to https without checking the certificate (as RFC 8555 permits). With `PKI_ACME_INTERNAL_ONLY` off (the
  default) http-01 may connect to public addresses; it never connects to cloud metadata or other link-local addresses
  and only fetches the fixed challenge path, but anyone can make the server connect to port `PKI_ACME_HTTP_PORT` of a
  name the profile allows. External account binding is optional per tenant; its MAC keys are sealed with the tenant
  key. Account deactivation and administrator revocation do not revoke certificates already issued.
- Certificate export and lifecycle (Sprint 25, B-1606): PKCS#12 files use PBES2/AES-256-CBC with an HMAC-SHA256 MAC,
  which readers older than OpenSSL 1.1.1 may not open (no legacy RC2/3DES variant is offered). A key made with
  `generateKey` exists in the app process while it is wrapped into the PKCS#12 file and is only as safe as the
  password the caller chose and the channel the response travels over; it is never stored. Renewal without a CSR
  keeps the old key, which is the wrong choice after a key compromise (send a new CSR and revoke the old
  certificate). Expiry notices go to the requesting user or to the tenant's `pki:manage` holders; ACME account
  contacts are not emailed.
- HTTP Message Signatures (RFC 9421, Sprint 20): a subset (`@method`, `@target-uri`, `@authority`, `@path`,
  `@query`, header fields; no component parameters; `ed25519` and `hmac-sha256`). A signed `/v1` request is accepted
  within `HTTP_SIGNATURE_MAX_AGE_SECONDS` of its `created` time and nonces are not remembered, so a captured request
  can be replayed within that window over a broken TLS link. `@target-uri` is checked against `PUBLIC_URL`; a proxy
  that serves `/v1` under another origin or prefix breaks verification.
- Supply chain (Sprint 20): `npm audit signatures`, the SLSA provenance attestation, the cosign keyless signature and
  its verification, and the release SBOM upload run only in GitHub Actions (on pushes to `main` and on `v*` tags, with
  the workflow's OIDC token) and were validated with actionlint, not run from this repository; they assume the image
  is published to GHCR as `ghcr.io/<owner>/<repo>`.
- Key-encryption keys are re-wrapped with `kms:rewrap` (data keys, checkpoint signatures, backup archives and
  manifests). Image provenance manifests (the row and the copy inside the PNG) and training model cards are re-signed
  too; a model card whose signed fields changed after registration cannot be verified with the previous key and is
  reported as failed rather than re-signed. OpenBao's own key
  versions are rotated and re-wrapped in OpenBao (`transit/keys/<name>/rotate`, `transit/rewrap`).
- Step-up (`STEPUP_WINDOW_SECONDS`) accepts the password only from accounts whose store checks passwords (local, LDAP,
  SQL). A session from an upstream OIDC or SAML provider steps up by signing in there again (`prompt=login` and
  `max_age=0`, or `ForceAuthn`); it counts only when the IdP reports a fresh authentication (`auth_time` or
  `AuthnInstant` after the request), as the same upstream account, redeemed by the same console session. An IdP that
  ignores these requests cannot be used for step-up.
- New sign-in notices tell a device by a long-lived signed cookie, so a cleared cookie jar or a private window counts
  as a new browser; a network is the /24 or /48 of the address the server sees (`req.ip`, so configure the trusted
  proxy). An account's first sign-in is recorded without a notice. With `BREACHED_PASSWORDS` using the range API, the
  strength meter queries it (k-anonymity prefix only) as the user types, throttled per session or link.
- The breached-password check is off by default (`BREACHED_PASSWORDS=off`): the range API is on the internet, so an
  air-gapped site needs an internal mirror or the offline file. When a source cannot be reached the password is
  accepted (fail open) and `password.breach_check.unavailable` is audited. Directory passwords (LDAP, SQL) are never
  checked here; the directory's own policy applies.
- Leaked-password lists (1.9.0, B-192, B-193): migration `131_leaked_password_lists` is not registered yet, so until it
  is the lists are not installed and every check is the `BREACHED_*` one. A tenant may fail closed (503) when a list
  cannot be read; the platform default stays fail open. Directory accounts are checked against new lists only when
  their password is set here, not at sign-in. A full HIBP mirror is about 1 billion hashes: about 20 GB of shards and
  a Bloom filter capped by `LEAKED_BLOOM_MAX_MB` (512 MB gives about 10% false positives, each one a shard read, never
  a wrong answer); the staging chunks need as much again until the build ends. A version's filter is read whole into
  memory on its first check on each instance. A Bloom filter or shard missing from the blob store makes that list
  unavailable, not empty.
- A password reset request answers the same whether or not the account exists, but the server does a little more
  work (a token row and an email hand-off) when it does, so response time is not strictly constant. Reset and invite
  links need `SMTP_URL`. An admin password reset ends the account's sessions and OAuth grants and, unless the admin
  unticks it, its API keys.
- OpenAI-compatible API (`/v1`): requests are stateless and nothing is stored as a conversation. Knowledge and memory
  context apply only when asked for (`X-Exprsn-Knowledge`, `X-Exprsn-Memory`), and the profile's read-only tools run
  on the server only with `X-Exprsn-Tools: profile` (write and destructive tools are never offered there); otherwise
  the client's tools are offered and their calls returned to it. A `require-approval` on the prompt refuses the
  request (there is no conversation to hold it in). Citations come back in the `exprsn` extension field, which strict
  OpenAI clients ignore. An OAuth
  token whose only inference scopes are `inference:invoke:<profile>` is bound to those profiles (by name or alias) in
  chat, agent runs and `/v1`; embeddings are not profiles and stay open to it. With `OPENAI_STREAM_MODE=live` tokens are sent before the output guardrail has run, so a later block
  can only end the stream with `finish_reason: content_filter`; the default `checked` mode sends the answer after the
  check, at the cost of time to first token.
- Webhooks: a delivery carries the audit event's target and detail (within the webhook's label ceiling) to the
  endpoint, so the endpoint must be trusted with them. Deliveries are not ordered unless the webhook asks for it; ordered
  delivery keeps the order in which events were queued across all instances (a position counter and a delivery lease
  per endpoint in the database, Sprint 23). Two events raised at the same moment on two instances are ordered by
  which one queued first, not by a clock, and receivers should still de-duplicate by the event id (a replay reuses
  it). The HMAC secret is sealed at rest and shared with the receiver; Ed25519 signing uses a per-tenant key
  whose private half is sealed with the tenant key and held in memory while signing (not in the KMS). Endpoint names are resolved again when dialled; every address is checked in the dispatcher's lookup
  against the operator's rules and the tenant's list, as for MCP servers.
- Conversation sharing: readers of a user or workspace share can watch an answer stream (Sprint 16), answer text only
  (no thinking); a revocation, a label rising above them, or (since 1.3.0) leaving the shared workspace (removed by an
  admin, or through a group mapping or the directory) ends it at once on every instance. Signed-in link shares open the transcript but
  do not stream. Anonymous links are off by default per tenant, open only conversations labelled `public` at that
  moment, expire within the tenant's limit (72 hours by default), are rate-limited per client address
  (`SHARE_ANONYMOUS_PER_MINUTE`, shared through Redis when set) and are audited with the address; anyone holding the
  link can read the conversation until then, and the address is only as reliable as the proxy settings.
- Stored API responses (1.3.0): `POST /v1/responses` with `store: true` saves the exchange as a chat conversation of
  the caller (in the key's workspace, `X-Workspace`), subject to chat retention; `previous_response_id` continues only
  the caller's own stored responses. Function calls returned to the caller are stored with the answer so a following
  function result matches them; function results and images in a stored turn are kept as text in the question.
  `store` defaults to false, unlike OpenAI's API.
- Evaluations (1.3.0): eval cases and results are sealed with the tenant key. A run answers each case with the saved
  profile through the gateway and the `model-output` checkpoint and is metered as `api` usage of whoever started it.
  The publish gate keys runs to a hash of the settings that shape an answer (model, pool, context, temperature,
  thinking, system prompt, tools, label), not to the canary model: a canary is not evaluated. A judge profile is an
  LLM: its verdict is only as reliable as the model, and an unreadable verdict scores 0. Overrides need a second
  profile admin.
- Scheduled agent runs (1.3.0): a schedule runs as its owner with the roles, clearance and workspace memberships they
  hold at its due time, never more; a due time missed while no instance was running fires once at the next tick, not
  once per missed time. Cron expressions are UTC.
- Billing: there is no currency conversion; a tenant with a currency is priced only from books in it. Proration
  (Sprint 23) follows price changes within a book by the moment they take effect; moving a tenant to another book
  mid-month prices the whole month from the book in effect when the statement is computed.
  Taxes are flat percentages of the priced subtotal, without tax registration numbers, exemptions or jurisdictions.
  The Stripe webhook reconciles paid, failed and voided invoices by the Stripe-Signature HMAC with a timestamp
  tolerance, and (Sprint 23) refunds, credit notes and disputes. A refund or dispute is matched only when it names the
  invoice or the charge or payment intent recorded from the invoice's paid event; credit notes are recorded with their
  amounts but do not change the statement's state. Statements are computed from `usage_records`, so usage deleted
  with a tenant's data is gone from later recomputations; push a finished month to keep it.
- Prompt templates pass the `user-input` checkpoint when they are saved and when a version is published (Sprint 16);
  a template published before a rule existed stays usable until it is published again, and the filled text still
  passes the checkpoint when it is sent.
- Operator-chosen service URLs (pool instances, zone endpoints, image backends, the training worker) refuse cloud
  metadata, link-local and unspecified addresses when saved and at every connection (the address dialled is the one
  checked); loopback and private addresses are the normal case and stay allowed, and public addresses are allowed
  too unless `SERVICE_INTERNAL_ONLY` is set. Image backends and the trainer come from the environment, so a refused
  address shows up when they are called, not at start. Git sources refuse link-local hosts, but git's own DNS lookup
  is not pinned to the checked address.
- `REQUIRE_BACKEND_TLS` is off by default, so an upgraded production deployment keeps starting with plaintext
  backend links until the operator turns it on; it checks the connection settings (sslmode, `rediss://`, `https://`),
  not the certificate the server presents, which is left to each driver's own verification.
- Diagnostic messages are masked by pattern (credentials in URLs, `key=value` secrets, authorization values, private
  keys) and, for data connections, by the connection's own password; a driver that reports a secret in another form
  (a bare value with no key name) is masked only when it is the connection's password.
- Media and image files are served with `Content-Security-Policy: sandbox` and `nosniff`; without `MEDIA_ORIGIN`
  they still come from the console's origin (sandboxed, so script in them cannot reach it). Signed media URLs are
  bearer URLs for their lifetime (`MEDIA_URL_TTL_SECONDS`).
- Security notices cover password, factor, recovery-code, API-key and session changes; a new sign-in does not send
  one. Email notices need `SMTP_URL` and an address on the account.
- Without `REDIS_URL`, rate limits are per instance (in memory); quotas are shared through the database.
- Tracing (1.3.0): spans go to `OTEL_EXPORTER_OTLP_ENDPOINT` over OTLP/HTTP JSON with only allow-listed attribute keys
  (method, route template, status, table and operation, job type, guardrail checkpoint and outcome, model name); SQL
  text, URLs with query strings, message text and error messages are never recorded. The exporter does not use TLS
  client certificates; put the collector on the internal network or behind a sidecar, and give an API key through
  `OTEL_EXPORTER_OTLP_HEADERS` (an environment variable, with no `_FILE` form yet).
- Key escrow (1.3.0): `kms:escrow` splits only the local key-encryption key, `DATA_KEY` or, when the signer holds it, the signer's key file
  (`--key-file`; with OpenBao, use its own recovery shares) and
  prints the shares to standard output once; run it on a terminal, not in a logged CI job. Shares of an earlier escrow
  stay valid for the key they were made from: after a key change (`kms:rewrap`), make a new escrow and destroy the old
  shares. `kms:recover` writes the key to a new file with mode 0600, never to standard output.
- Schema handshake (1.3.0): an instance whose build is older than the database's newest migration stops taking jobs
  and reports not ready, but keeps answering requests that reach it until its load balancer drains it. Expand-only
  migrations keep the previous release working during a rolling upgrade; a contract step (marked `// contract:`) needs
  every old instance stopped first, which `migrate --check` reports.
- Secrets vault (1.4.0, B-1701 to B-1703): KV values and transit key material are sealed with the tenant data key, so
  they are as strong as its key-encryption key (local `DATA_KEY`, the signer, or OpenBao transit when
  `KMS_PROVIDER=openbao`) and are crypto-shredded with the tenant. Transit operations themselves run in the app
  process: the material is opened in memory for each call and never exported, but it is not held by OpenBao transit
  or the signer the way the OIDC and webhook keys are; an OpenBao-native transit backend (named keys in OpenBao, its
  own `min_decryption_version`) is not built. Vault paths and transit names are lower case only, so they compare the
  same way on every database. A grant to a directory group follows the groups the user's stores reported at the last
  sign-in or sync. Encrypt and verify calls are not audited (they reveal nothing); decrypt, rewrap, sign and every
  read of a secret are.
- Plugins (1.4.0, Sprints 24c and 25): a plugin is data; its declarative actions run through the existing services and
  its script handler in the script sandbox (no network, never in the server process), each gated by a granted
  capability, and every webhook endpoint it names is checked against the outbound host rules at install, at enable
  and at each delivery. Loop rule: whatever a plugin's work causes carries the chain of plugins behind it (in process
  while the invocation runs, in the invocation row across the job queue, and in the trigger of a workflow run a plugin
  started); an event is never delivered to a plugin already in its chain, and not at all once the chain is
  `PLUGIN_MAX_DEPTH` long; the plugin and webhook deliveries' own job states are never events for plugins. What leaves
  the platform is not traced: a webhook receiver (or a workflow's HTTP step) that calls the API back starts a fresh
  chain, so such a loop is bounded only by `PLUGIN_RATE_PER_MINUTE`. The in-process part of the chain rides an
  AsyncLocalStorage: work an action's callee defers to its own timers or connections opened during the action would
  carry it too, which only ever suppresses deliveries. A script handler holds its invocation's token (shown to it
  once, stored hashed, revoked when it ends); with the default sandbox it cannot use it except over its own stdin and
  stdout, but a sandbox with network could replay it to `/plugin-broker` until it expires or is revoked. Since 1.5.0
  (B-3904) the `records`, `files`, `groups` and `posts` calls are live and act as the installing user (still active,
  holding the domain permission, clearance capped at the plugin's max label), so a plugin reaches what its installer
  can reach, not what the plugin needs: a narrower plugin needs a narrower installer (a service account), and a
  plugin installed from the command line cannot make them. `read:files` returns contents (up to 256 kB a call), not
  just metadata, and is still a low-risk capability, granted with the manifest. The test suite runs handlers
  as local processes (`server/test/sprint25d-fakes.ts`); the container path is the scripts' and is not exercised in CI.
  Plugin logs and invocation events are sealed, but kept until the plugin is removed from the database by hand (no
  retention yet).
- Event catalogue (1.4.0): an emitted event that does not match its schema is still delivered (counted and logged),
  so a receiver must still validate what it gets. The `post` types are reserved, not emitted (the `record`, `file`,
  `group` and `message` types are emitted since their domains shipped).
- Read-through cache (1.4.0): with Redis, cached values sit in Redis unsealed, so only ids and settings are cached,
  never tenant content (today: each tenant's list of enabled plugins). A Redis failure makes reads go to the database
  (`exprsn_cache_errors_total`); a cached value can outlive a change on an instance that missed the bus message by at
  most its tier's TTL.
- Realtime rooms (1.4.0): groups (`group`) and messaging (`conversation`) register authorisers; a `room.join` for a
  kind nobody registered (`feed`, `channel` until they ship) is refused. Client signals into a room (`room.signal`:
  typing and receipts) are accepted only from a socket in that room, capped per socket (`ROOM_SIGNALS_PER_MINUTE`),
  and relayed only as the domain decides.
- Database leases (1.4.0, B-1704): the built-in engines hold an admin login to each target database (sealed, or a
  `vault:` reference read as the user who registered the engine), so whoever can act as that user's vault policy can
  make accounts there; registration needs `connections:manage` and a zone whose ceiling covers the engine. Only
  PostgreSQL accounts carry their expiry (`VALID UNTIL`); MySQL accounts live until the sweeper drops them, so a
  stopped sweeper (or `VAULT_LEASE_SWEEP_SECONDS=0`) leaves MySQL leases usable past their expiry. Ending a lease's
  open sessions needs `pg_signal_backend` (PostgreSQL) or `CONNECTION_ADMIN` (MySQL) on the admin login; without them
  a session opened before the drop runs on until it disconnects. When the admin login is a vault reference whose
  owner loses read on it, leases can be neither issued nor dropped until it is restored (the sweeper keeps retrying
  and the admins are told). Objects an account created itself (possible on PostgreSQL before 15 through `PUBLIC`'s
  `CREATE` on `public`) are dropped with it.
- Vault references (1.4.0, B-1705): a reference resolves as the user who saved the object (for workflow HTTP steps,
  as the user who started the run), every time it is used; changing that user's policy or disabling them stops the
  reference at its next use, except where a driver already holds an open pool: a SQL user store keeps its database
  pool until the store is saved again or the server restarts (LDAP binds, connections, MCP calls, engines and workflow
  steps read the reference every time). Stores defined in the configuration file have no owner and
  cannot use `vault:` references. Only KV secrets can be referenced, not transit keys or leases.
- Rotation schedules (1.4.0, B-1706): KV secrets cannot be rotated by the server (it does not know how to make the
  next value), so their schedules only notify; transit keys can rotate themselves (`autoRotate`). Notices are checked
  every `VAULT_ROTATION_CHECK_MINUTES`, so one can arrive up to that late.
- AT-Protocol trust (1.4.0, Sprint 25): DAG-CBOR, CIDs, did:key, did:plc and low-S ECDSA are implemented here and
  pinned by known-answer tests from the reference libraries, but have not been run against the live PLC directory,
  Bluesky's AppView or Ozone; treat interoperability as unproven until the interop tests of the Risks table run.
  secp256k1 keys need the signer (OpenBao transit has no secp256k1 key type); under OpenBao only P-256 is offered.
  Making or rotating the platform identity needs `platform:manage` and a recent sign-in, not a second admin. A
  `did:plc` key rotation is applied here only after the directory accepts it; if the directory accepts and this
  server then fails to record it, the identity must be repaired by hand from the directory's log (no reconciliation
  job yet), and a rotation that the directory refuses leaves an unused key in the signer's or OpenBao's custody.
  Labels signed by a retired key are re-signed when next served, so a consumer that cached an old label sees two
  signatures over the same label. Path-form tenant labelers (`<base>/atproto/<slug>`) have a path in their service
  endpoint, which some AT-Protocol clients drop; a tenant that needs broad interoperability should use its own host.
  The `did:web` path is the tenant slug at creation; renaming the tenant does not move it. Tenants that fall back to
  the platform identity share its labels: a value one tenant put on a subject is in force for all of them, and only
  that tenant can withdraw it. Inbound labels are read
  from `subscribeLabels` only (no push), from cursor 0 for a new labeler (a large labeler's history takes several
  pulls of 5,000 messages); a labeler's negation is stored but does not close the flag its earlier label raised.
  The verdict-to-label mapping uses a fixed keyword table over rule names and details. The labeler declaration
  record (`app.bsky.labeler.service`) needs a PDS, which Exprsn-AI does not host, so clients only act on the global
  values (`!hide`, `!warn`, `porn`, `sexual`, `nudity`, `graphic-media`) unless they read this labeler's values some
  other way.
- AT-Protocol accounts (1.4.0, Sprint 26, B-1807, B-1808): the OAuth client (PAR, PKCE, DPoP with server nonces,
  `private_key_jwt`, the issuer check through the account's own PDS) has only been run against the local PDS double in
  `server/test/sprint26b-fakes.ts`, never against bsky.social or another real PDS; treat interoperability as unproven.
  Real authorization servers require an https `client_id`, so AT-Protocol sign-in needs `FEDERATION_ISSUER` (or
  `PUBLIC_URL`) on https and reachable from the internet, and outbound https to PDSes, which `SERVICE_INTERNAL_ONLY`
  blocks unless their hosts are allow-listed. Plain http to loopback addresses is accepted outside production only.
  Client assertions are signed with the tenant's OIDC signing key (published at its jwks_uri), not a key of their own.
  Tokens are revoked and discarded after sign-in, so nothing can act on the account's repository; the `atproto` scope
  only. A DID bound to a user signs in as that user without that user's password: binding needs a recent sign-in, and
  an admin role still needs its second factor, but an AT-Protocol user without a local factor cannot step up for
  actions that need a recent sign-in (upstream step-up covers OIDC and SAML only). The profile challenge reads the
  `app.bsky.actor.profile` record, which accounts outside Bluesky may not have (they can link by signing in instead);
  whoever runs the account's PDS can also write that record. The handle stored with a binding is checked when it is set,
  not again later (sign-in checks the handle it uses each time). Handles under `.test` are accepted outside production.
- File store (1.4.0, Sprint 26d): content is sealed in 64 KiB AES-GCM segments under a random key per version, and
  that key is sealed with the tenant key, so offboarding crypto-shreds files with the rest of the tenant's content.
  The quarantine scan reads the whole file twice (type check and classification, then ClamAV); ClamAV refuses streams
  above its `StreamMaxLength` (25 MB by default), which rejects larger files until the operator raises it to
  `FILES_MAX_BYTES`. Zip archives are buffered to find out whether they are Office documents, so larger zips than
  32 MiB are refused; only text, PDF, Word, Excel, PowerPoint, PNG, JPEG, WebP and GIF are accepted. Classification
  for personal and financial data covers text files only (PDFs and Office files are classified when a knowledge
  source indexes them, not in the store). Sharing is per file (not per folder) and read-only; a group share matches
  the groups the reader's identities carried at their last sign-in or directory sync. A link's use is consumed when
  the download starts, so a download that fails part-way still counts. Anonymous links follow the conversation
  settings (one tenant switch for both) and have no landing page or metadata route: the holder can only download.
  Previews are drawn by external tools (ffmpeg, poppler's pdftoppm) on the server, as argument arrays without a
  shell, from a decrypted temporary copy in `FILES_WORK_DIR` (mode 0600, removed afterwards); run them in a
  sandboxed host or container if untrusted PDFs are a concern. A folder used as a knowledge source is indexed on the
  source's schedule, not when a file changes, and only files at or below the knowledge base's label; whoever may read
  the base reads what it indexed, so the curator adding the folder decides who sees its contents. Storage quotas
  count every stored and quarantined version (trash included, previews not); two uploads racing at the limit are
  checked again after they are recorded, so one may be refused that would have fitted after the other failed.
  Files are not yet moderation objects: `FileService.moderationTarget` and `takeDown` are ready for the moderation
  object registry (B-1901) to call.
- Moderation (1.4.0, Sprint 26): a check of a registered object inspects its stored text: a message's content, but
  only a knowledge document's name, a media asset's name and an image's prompt, unless the caller passes the text
  (there is no OCR or transcript step, and the image-safety classifier stays separate). Hiding is a state on the
  object; a knowledge document whose source later syncs changed content goes back to indexing and is no longer
  hidden, and its next check decides again. A suspended or banned user cannot sign in to appeal: they ask an
  administrator, and a reviewer files the appeal for them (`forUserId`). Enforcement reads a cached sanction (the
  short cache tier, cleared over the bus on every change), and a sanction's end is compared at each request, so the
  sweep only records it. A sanction does not revoke API keys or OAuth grants; they are refused while it lasts and work
  again after it. Review queues route a flag when it is created (adding a queue does not route older flags) and
  escalate one level, once; unrouted flags keep the breach notice only. Dead letters are recorded by the instance on
  which the job failed. External providers receive the object's text (up to 32,000 characters) and its type; the
  zone check reads the zone definitions, while the network itself is held by the zone's NetworkPolicy or nftables
  rules. Notices carry the moderator's reason, not the moderated content.
- Firehose ingest (1.4.0, Sprint 27, B-1908): tested against a local Jetstream and relay double only, not yet against
  the public Jetstream or a live relay. Since 1.5.0 (B-3604) a subscribeRepos commit is verified against the repo's
  DID key and each record used is proven against its signed Merkle tree, and a commit that fails is dropped and
  audited (see the Sprint 31 entry above); Jetstream still carries no proofs at all, so trust a Jetstream endpoint you
  subscribe to.
  Ingested posts are an unregistered moderation type (`atproto-post`): they are checked with their text and get a flag
  and labels, but cannot be reported, hidden or appealed through the object registry (Exprsn-AI does not store them),
  and a deleted post's labels are not withdrawn. Images and video are not fetched; only text and alt text are checked.
  The flag stores the post text (sealed, as for any flag). A consumer is held by one instance through a lease of three
  `FIREHOSE_TICK_MS`; after a crash another instance takes over when the lease runs out and resumes from the last
  stored cursor (at most `FIREHOSE_CHECKPOINT_MS` old), so posts handled since are checked again (a check is idempotent
  per post: one flag). A failed check is retried three times and then counted as `failed` and skipped.
- Groups and events (1.4.0, Sprint 27c). Workspace membership is checked on every request, so a member who leaves
  the workspace loses its groups at once, but their membership and RSVP rows stay (they come back if the user
  rejoins the workspace). Group names are stored in the clear (like file names); descriptions, posts and event titles,
  descriptions and locations are sealed. In-app notices name the group, which a notification row stores in the clear;
  emails carry only the time and a link. Calendar feed URLs are bearer credentials: anyone holding one reads the
  owner's events up to `CALENDAR_FEED_MAX_LABEL` (above it, busy time only) until the owner revokes it, and calendar
  programs fetch them over the network, so a URL in a mail client or third-party calendar should be treated as
  shared. Feed signatures use a key derived from `SESSION_SECRET`; rotating it invalidates every feed (there is no
  per-feed key rotation other than revoking and creating a new one). Feed fetches are not audited one by one (they
  record `lastUsedAt`); creation and revocation are. Events have no recurrence and no VTIMEZONE (times are UTC, which
  RFC 5545 allows); a wall-clock time in a daylight-saving gap moves forward by the gap. Reminders go to attendees
  who said going or maybe, not to every member. Capacity is checked under a lock on the event row (since 1.5.0,
  B-3603), so simultaneous RSVPs for the last place take turns; a check-in at the door still adds an attendee past the
  capacity, on purpose. Group posts are small discussion content
  (no edit, no attachments, no threads); the workspace feed is B-27.
- Customer-service channels (1.4.0, Sprint 28a, B-23). Customer sessions are public by design: the channel's public
  key is not a secret, so anyone can start an anonymous session on a chat channel that allows them, limited per client
  address (`CHANNELS_SESSIONS_PER_HOUR` and the channel's own `sessionsPerHour`) and per session
  (`messagesPerMinute`); behind a proxy the address is only as good as `TRUST_PROXY`. Set the channel's label to what
  anonymous people may receive (`public` or `internal`): the label limits the profile, agent and pool that answer, not
  what a customer may type. Channels answer from the profile's or agent's prompt only: no knowledge retrieval, memory
  or tools (an agent's tools never run for a customer). Session tokens are bearer credentials for one session (HMAC
  with a key derived from `SESSION_SECRET`, `CHANNELS_SESSION_HOURS`); they cannot be revoked one by one except by
  closing or hiding the session. Identity assertions are signed by the channel's site with the channel's identity
  secret (shown once); a leaked secret lets anyone act as any customer of that channel until it is rotated, and
  assertions carry no audience or nonce, so one is replayable until its `exp` (at most a day). Customers poll for
  answers released by review; there is no customer socket. Transcripts, customer names, addresses and subjects are
  sealed; the `customer_key` that threads email is an HMAC (with `SESSION_SECRET`) of the address, so rotating that
  secret breaks threading for earlier customers (their next mail starts a new session). Email threading trusts
  `In-Reply-To`/`References` only together with the sender address, which a spoofed `From` can still forge where the
  receiving mail server does not enforce SPF/DKIM/DMARC; an attacker who knows a customer's address and one of the
  thread's Message-IDs could add a message to that session (they still never see the replies, which go to the real
  address). IMAP polls read the mailbox read-only and never mark or move messages; messages over 10 MB are skipped.
  Since Sprint 34 (B-3605) the imapflow adapter also runs in CI against GreenMail over implicit TLS with the
  certificate verified against the host name (`server/test/integration/imap.test.ts`); the STARTTLS path (port 143)
  is exercised only through imapflow's own handling, not against a server.
  Mailgun inbound is form-encoded only (routes that forward attachments post multipart, which is refused with `415`);
  Postmark, SendGrid and others use the generic shape through a relay. Bounces from IMAP are read from RFC 3464
  delivery reports only (not from free-text bounce mails). Held replies use the flag queue: a reviewer who can see the
  flag and holds `flags:review` can approve or reject it there; only `channels:review` holders can edit. Retention is
  per channel on last activity; purged sessions' open review flags are closed as rejected directly (without a flag
  event). Channel CSV exports are sealed in the blob store until downloaded by the person who asked, and not deleted
  afterwards, like app exports.
- Channels that run their agent's tools (`agentTools`). The person at a customer channel is not an account, so the
  tools run as the channel's `runAs` account, which must hold member permissions only and belong to the channel's
  workspace; its clearance is lowered to the session's label for every call. Only read tools that need no
  confirmation are offered, so nothing a customer writes can make the channel send, post, save or delete. Tool
  results reach the model as untrusted content, as in agent runs, and the answer still passes the `model-output`
  checkpoint and the channel's review mode. Known gap: what the run-as account may read (knowledge bases shared with
  members, its workspace's memories) can reach any customer of the channel, so a channel that allows anonymous
  sessions should run as an account that sees only what may be public.
- Email one-time codes (1.4.0, Sprint 28a, B-1806). An email factor is weaker than TOTP or a passkey: whoever reads
  the mailbox has the factor, and email travels through servers outside the deployment. It is offered because some
  users have nothing else; roles that require a second factor accept it too (the MFA policy does not tell factors
  apart yet). The address is the account's address at enrolment, kept sealed in the factor, so a later change of the
  account's address does not move the factor (remove and enrol again). Codes are six digits, valid for
  `MFA_EMAIL_CODE_MINUTES`, single use, bound to the pending session they were sent for, and their wrong guesses count
  in the same lockout as TOTP codes. Step-up re-authentication does not take email codes yet.
- Social relations (1.4.0, Sprint 28b, B-2606). Blocks, mutes, follows and lists are stored in the clear (user ids
  only) and audited under `social.*`, so tenant auditors and `social:manage` holders can see who blocked or follows
  whom (an admin's view of one user's relations is itself audited). A block is checked when a message, post or socket
  event is raised: events already relayed before the block are not withdrawn, and a socket already in a room keeps
  receiving other people's events there (only the blocked pair's events to each other are left out). The contact rule
  applies when a conversation is started or a person added; a conversation that already exists keeps working until
  one of the two blocks the other.
- Messaging (1.4.0, Sprint 28b, B-26). Messages and conversation titles are sealed with the tenant key (the row id as
  associated data); there is no end-to-end encryption, by design, so the server (and so a tenant's operators with the
  key) can read them, which is what lets search, summaries and moderation work. The keyword index holds keyed hashes
  of words (as knowledge does), which reveal which messages share a word to someone with database access but not the
  word; vectors for semantic search (`MESSAGING_EMBED_MODEL`) are stored unsealed in the vector store, like knowledge
  vectors, and are approximately invertible. A deleted message keeps its row as a tombstone (author, times, edit count)
  and loses its body, attachments list, terms, vector and reactions; earlier sealed bodies of an edited message are
  overwritten, not kept, and backups taken before the delete still hold them until they expire. Attachments are file
  ids from the file store: a file must have passed its scan and lie in a workspace every member can read it through,
  but trashing, re-labelling or taking down the file later is the file store's business (the message shows its state).
  Direct conversations have no workspace: they need the two people to share one now, so losing that common workspace
  hides the conversation from both. A member added to a group conversation reads from the moment they were added.
  Receipts, typing and presence are not audited (they are not changes to content); presence is the time a socket last
  joined or left the room, not a live status, and reflects only sockets in that conversation's room. Summaries and
  digests send the visible messages (up to `MESSAGING_SUMMARY_MAX_MESSAGES`, each cut to 2,000 characters) to the
  profile's model through the gateway and meter it like workflow model calls; they run in the request, not as a job.
  Notifications name the sender (and that it was a group conversation), never the text or the title.
- Workspace feed (1.4.0, Sprint 28c, B-27). Post bodies, comments and digest summaries are sealed; hashtags (lower
  case), reactions, bookmarks, the trending counts and each digest's ranked post ids are stored in the clear so they
  can be queried and counted. Realtime feed events carry ids only and are filtered when raised: people whose stored
  clearance is below the post's label and everyone in a block with the author are left out, but someone who joined a
  workspace room learns that a post id exists before fetching it (the fetch applies clearance, blocks and group
  membership again). A block hides content from the moment it is made; events already relayed are not withdrawn, and
  a digest summary written before a block may still name the blocked person (its post list is filtered at read). The
  digest is written by a model from the posts' text: it is screened at `model-output`, but a summary can misstate a
  post. Since 1.7.0 (B-9402) an edit or a comment that a rule would hold waits for review like a post (see held
  messages below), and a quoted repost is held like a post. Group posts' hashtags are left out of trending; a workspace's trending tags are visible to its
  members at each label they are cleared for, so a tag used only in internal posts is visible to every internal
  reader. The home fan-out uses stored workspace and group membership: tenant admins who read every workspace get
  their followed people's posts on the next load rather than live. Comments are not threaded beyond `parentId` (no
  depth limit) and send no notifications.
- Identity gaps (1.4.0, Sprint 26a). Self-registration is closed unless a tenant admin opens it; its accounts get only
  the member, flag-reviewer or knowledge-curator roles. Sign-up answers say whether a username or address is taken
  (as most registration forms do); they are throttled per client address and per address. Email verification is off
  until a tenant turns it on; addresses that an admin typed, imported or invited count as proven, and directory
  accounts' addresses belong to the directory. There is no per-workspace admin role yet: `members:invite` is a
  tenant-wide permission (tenant and identity admins), limited to the inviter's own workspaces and to roles they may
  grant. A trusted device skips the second factor for the tenant's `trustedDeviceDays`, but never for accounts whose
  roles require a second factor (admins) or that are marked as needing one: those are asked for it on every sign-in.
  For everyone else it is bound to the device cookie, so a stolen cookie together with the password passes until the
  period ends or the user's sessions are revoked (a plain sign-out keeps the trust). The MFA grace period starts when
  the requirement last widened, not per user. GitHub sign-in reads organisation and team membership once per sign-in;
  leaving a team takes effect at the next sign-in (there is no directory sync for GitHub), and an organisation that
  restricts OAuth app access hides its membership until the app is approved there. Step-up re-authentication through
  GitHub is not offered (GitHub has no `prompt=login`); GitHub accounts step up with a second factor. CSV imports create accounts with a
  password nobody knows: the users need an invitation link (`sendInvites`) or a reset by an admin.
- Low-code apps (1.4.0, Sprint 27, B-22). Records are sealed with the tenant key (the record id as associated data),
  but sealed values cannot be filtered in SQL, so the design is deliberate: a designer marks the fields that may be
  filtered, sorted, searched and aggregated `indexed`, and those values (lower-cased text, numbers, dates as epoch
  milliseconds, booleans) are also stored **in clear** in `app_record_values`, readable by anyone with database
  access. Mark only fields that are not sensitive; everything else (notes, JSON, unindexed text, AI fields unless
  marked) stays only in the sealed record. A `unique` field stores an unkeyed SHA-256 of the entity, field and
  normalised value in `app_unique_values`; a low-entropy value (a small number, a common word) can be guessed from
  it by someone with database access. Indexed text is compared lower-cased after Unicode NFC, byte-wise (no accent
  folding, no locale collation: `é` sorts after `z`), and is at most 255 characters, so an indexed text field has a
  `maxLength` of at most 255; uniqueness is case-insensitive. Filters cover a tested subset (`eq`, `ne`, `gt`, `gte`,
  `lt`, `lte`, `in`, `contains`, `startsWith`, `exists`, with `and`, `or`, `not`), with the same results on every
  dialect; PostgreSQL's plans differ only in its collated, partial value indexes (031b). Offset pagination stops at
  100,000; a cursor (keyset paging, B-3601, 1.5.0) goes further at the cost of the first page, but each page still
  counts every match for `total`, so an entity with very many matching records costs that count on every page (an
  estimated total is not offered yet). A cursor is opaque but not sealed: it carries the last record's sort values
  and id, which the caller has just read, and is checked against the sort it is sent with. An existing field cannot become unique while the entity has records, and
  a field's type cannot change then. Formulas are parsed and walked (no `eval`), read only the entity's own non-computed
  fields, and give null on any error; they are computed on write (and by the reindex job), so `today()` and `now()`
  are the time of the last write. AI fields are filled by a job after the write, fail soft (an error leaves the field
  empty, recorded in `aiError` and audited) and are cleared when their inputs change until the job fills them again; a
  record written by a public form is filled with no person behind it (only the profile's label is checked). Public
  forms take only listed, visible fields, never files, references or user, workspace or record lookups, are limited per
  address (`APPS_PUBLIC_FORM_PER_MINUTE`) and per form, and screen every text value at `user-input`; since 1.6.0
  (B-4701) a held value makes a public submission wait for review (see Sprint 36b below). A form's link token is shown once and stored as an HMAC with `SESSION_SECRET`,
  so rotating that secret ends every public form link. Triggers run as their owner with what the owner holds when they
  fire; chains stop at `APPS_TRIGGER_MAX_DEPTH`, and a workflow's own record steps never fire its own triggers, but two
  workflows that update each other's entities stop only at that depth. A trigger's run input holds the record's values,
  sealed in the run like any workflow input. App bundles are signed with an HMAC key in the KMS
  (`<OPENBAO_KEY_PREFIX>app-bundles`), so they verify only on installations that share that key (the same `DATA_KEY`
  or OpenBao transit key); bundles between unrelated installations would need the offline-signed import bundles
  (B-2005), which do not carry apps yet. Bundles carry the design only (no records, triggers or form links). CSV
  exports are sealed in the blob store until downloaded by the person who asked, and are not deleted afterwards; the
  CSV of an import is dropped from its row once the job has run. A CSV import travels in the JSON body, so it is at
  most `APPS_IMPORT_MAX_BYTES` (200 kB by default, under the API's 256 kB limit).
- Gateway slots: a chat turn's own requests (embeddings, guard-model verdicts on the streamed text and on tool results,
  tools that call a model) ride on the slot the turn holds instead of queueing for it (Sprint 26a), so Ollama may
  receive more concurrent requests on that instance than its `parallel` setting while a turn's verdicts run, and
  queues them itself. The `/v1` API, agent runs and workflows still lease a separate slot for each call they make.
- Workflow triggers, retries and bundles (1.5.0, Sprint 32b, B-3903, B-3906, B-3909): a workflow's own event and
  schedule triggers start runs as the person who published the version, with what they hold when the trigger fires;
  re-publishing makes the publisher the owner, so whoever publishes takes the runs on. The loop rule for event triggers
  covers only workflows: an event caused by a chain of workflow runs is not delivered to a workflow in the chain, and
  is dropped at `WORKFLOW_EVENT_MAX_DEPTH`, but the chain is not shared with plugins, app record triggers, sub-workflows
  or agents until B-4101's chain context replaces it (a plugin that starts a workflow whose events start that plugin
  again stops only at each kind's own limit and at the rate limits). The chain is carried in-process while a run
  executes and on the firing row; an effect that leaves through another job (a file version a step writes, whose
  `file.uploaded` comes from the scan job) is not traced, and `WORKFLOW_EVENT_RATE_PER_MINUTE` bounds it. Workspace
  scoping relies on the event naming its workspace (`data.workspace`, or the audit target's `workspace`): audit
  actions mostly name none, so only tenant-level workflows receive them. An event trigger's run input holds the event
  envelope, sealed like any run input; the firing row keeps it sealed too. A retry of a step that writes (an HTTP
  `POST` or `PUT`, a record step) may send it again (validation warns); retries are not idempotent beyond what the
  remote side ensures. A redriven dead letter replays the failed run from its failed step as the admin who redrives it,
  not as the run's original owner. Workflow bundles are signed with an HMAC key in the KMS
  (`<OPENBAO_KEY_PREFIX>workflow-bundles`), so, like app bundles, they verify only on installations that share that
  key; the signature proves where a bundle came from, not that its graph is safe, so an import is a draft that the
  importer reviews and publishes, and publishing validates every re-bound reference again.
- Workflows 2 steps (1.5.0, Sprint 32c). Domain built-ins (B-3904: `messages.send`, `feed.post`,
  `files.write_version`, `groups.create_event`, `channels.answer`) are platform registry entries that every tenant
  sees; a tenant cannot unpublish them, only keep them out of its agents and steps (and a write always needs an
  approval or a confirmed call). They act as the caller, so an agent or workflow can do whatever its owner can do in
  those domains once the call is approved; the label check stops data going somewhere labelled lower, but nothing
  stops a write at or above the data's label. Only feed posts record their source (`workflow-run`, `agent-run`…);
  messages, file versions, events and channel answers show the owner as the author, with the source only in the
  workflow's own run and audit entries. Approval-form answers are validated like a submission but not written
  anywhere, and are kept in full in the `workflow.approval.approved` audit entry at the run's label (as the run's
  outputs are), so a field that must not reach the audit chain must not be on such a form. Notify steps tell cleared,
  active users only, but resolve usernames in the whole tenant and skip unknown ones silently (counted, not named). A
  webhook step's endpoint is checked against the operator's and the tenant's host rules at save and at run time; the
  managed webhook it creates is visible on the Webhooks screen and removed with the workflow, but not when the step
  is removed from the graph (it then idles, subscribed to nothing). Webhook deliveries leave the platform at the
  step's label: the tenant's allowed hosts are the control, not the label (set a `ceiling` on the step to stop
  confidential data from reaching it).
- Red-team suites, agent identities and handoffs (1.6.0, Sprint 38b, B-7001, B-7002, B-7701, B-7801). The built-in
  attacks are a fixed catalogue in English (plus the corpus's other languages); a model that resists them may fall to
  phrasings it has not seen, and a tenant that does not add cases of its own measures only the catalogue. The judge is
  deterministic: an attack whose canary comes back paraphrased, or a leak of fewer than eight consecutive words of the
  system prompt, counts as resisted, and a benign answer that quotes the canary back ("I will not say FREEBIRD-01")
  counts as a success for the attack. Exfiltration is judged on the address the attack names; a model that reaches
  for another address is not caught. Workflow targets are judged on their step outputs with the attack in the first
  string field of the trigger input, and their runs are not cancelled when they pause; workflow red-team runs are
  finalised when their target is next read (there is no hook back from the workflow service). A red-team run of an
  agent is metered to the person who started it, like an evaluation. The red-team gate covers profiles and agents;
  workflows have suites and runs but no gate on publishing. Agent identities narrow by permission, not by object: an
  identity granted `knowledge:read` reads every knowledge base its owner may, and a tool's own side-effect approvals
  still apply. A key minted for an identity carries its owner's roles narrowed by the identity, so demoting the
  owner demotes the key, but a different owner minting a key for the same identity gets their own narrowing. A
  handoff hands the task the model wrote, not the run's messages; the specialist does not see the conversation.
- Image classification in Knowledge (1.6.0, Sprint 36c, B-8801 to B-8805). The thumbnail is the stored image served as
  is: nothing is resized on the server, so a large image is sent whole (the console scales it). HEIC images have no
  thumbnail, since browsers do not show them. Only JPEG and 8-bit RGB or grey Flate images are taken out of PDFs
  (JPEG 2000, CCITT, indexed colour and masked images are not); at most 20 images per document, and images under 1 KB
  are skipped as icons. A guardrail rule that names a vision classifier on text fails, and its `onError` decides. The
  vision profile's description and classification calls are metered as `embed` usage (knowledge indexing), with no
  user, not under a usage kind of their own.
- Row and field policies, DLP, legal holds and compliance exports (1.6.0, Sprint 38c). A record a reader creates
  outside the rows their policies allow is accepted and then out of their reach (the create grant is per field, not per
  row); a lookup field's option list is not narrowed by policies; a policy's row condition is one filter of at most 30
  conditions and 4 levels, and the reader's own filter is ANDed to it, not merged into those limits. DLP inspects at
  most `DLP_MAX_TEXT_BYTES` characters of a text (the rest keeps its label); streamed chat answers are inspected when
  finished, so a redacted span may have been shown while streaming, as with a guardrail redaction; the thinking of an
  answer is not inspected by DLP; uploads are inspected only when they are text (UTF-8 or JSON), not inside PDF or
  Office documents. A legal hold does not stop a user from deleting their own conversation, memory or file, and agent
  runs have no retention purge to suspend. A compliance export matches by `createdAt`, not by activity in the range;
  file bytes are not in it; conversations hold at most 10 000 messages each; nothing is signed, so an export's
  integrity rests on the audit events around it.
- Content credentials and artifacts (1.6.0, Sprint 39a). Content credentials are built from the specification's parts,
  not a reference library: no time stamp, no ingredient chain for variations, and an assertion hash over the content
  box; a third-party validator may flag those (see above). JPEG images from a ComfyUI worker carry neither manifest
  chunk. Verification judges certificate validity at the time of the check, so an image signed with a since-expired
  certificate reports `certificateValid: false` though it was valid when made. Artifacts are taken from fenced blocks
  only (a model that writes code without a fence makes none), names come from the fence's info string (two blocks the
  model names the same in one answer keep the first), and a conversation holds at most 200 artifacts. A render link
  is a bearer capability for its lifetime; anyone holding it can show that version until it expires.

- App packages, environments and promotion (1.6.0, Sprint 39b). A package carries the workflows its triggers name
  as drafts; the importer publishes them, and until then the triggers are skipped. A deployment applies entity changes
  through the designer's rules, so a field type change on an entity holding records fails the deployment (the backup
  stays beside it) rather than migrating values. A rollback restores the design, not the records written since; an
  entity that still holds records survives a rollback that would drop it. The approval workflow's trigger must accept
  the deployment input (or declare no schema). A pipeline's stages must be apps of one tenant; promotion across
  instances goes through git export and import, which is not two-way (a change in the repository is imported as a new
  app, not merged). Git pushes dial out through the address checks but not through the tenant's allowed-host list.
  Deployment history is pruned on read, not by a job.

- Data model drafts, AI fills and outside tables (1.6.0, Sprint 39c). A draft is only as good as the model: it may
  name fields that validate but mean little, and the diff shows what changes, not whether it is sensible. Debounced
  AI regeneration keys its window on the clock, so two edits either side of a window boundary ask twice; a fill's
  estimate samples prompts and assumes `maxLength` or 600 characters of output, and the cost uses the tenant's price
  at the time (B-7402's known gap applies). A pull reads at most `APPS_SOURCE_PULL_MAX_ROWS` rows and then stops
  deleting (a capped pull never removes records); pulls are full reads, not change streams; a write through to the
  table that succeeds but whose local write then fails leaves the row outside ahead of the app until the next pull;
  CSV imports into a sourced entity write through row by row (slow, and partial on a refusal); records above the
  connection's label that the designer created locally are pushed to a table that carries no labels.

- Entity APIs and app embedding (1.6.0, Sprint 39d). An entity named like one of the app's own route segments
  (`entities`, `forms`, `policies`, `triggers`, `export`, `schema`, `embed`, `transfers`, `drafts`, `import`, `held`)
  is reached only through `/entities/:entity/records`, not the entity API; `where` conditions are typed by their
  text (a string that looks like a number is a number); `include=related` fetches each related record separately
  (at most one call per distinct reference). A schema version holds the whole definition of a changed entity, not a
  diff, and nothing restores an earlier version. The generated TypeScript client types values loosely (`json` as
  `unknown`, formulas as `string | number | boolean`). An app-limited key is refused on `/v1` and the MCP server
  outright rather than narrowed to its app's tools. The embed page's `frame-ancestors` names whole origins, not
  paths; a public embed page is reachable by anyone who learns its random id (as a public form link is), and a
  submission is `source: form`, by no one. A signed embed names the person by a claim the host asserts: the host site
  is trusted for who is behind the browser, within what that person may do; the `host` recorded on a session is the
  token's `iss`, not the framing page; HS256 secrets are shared with the host site; the tenant CA path checks the
  leaf against the active intermediate only (no chain of several intermediates, no OCSP); ended sessions are purged
  by the next exchange's bookkeeping, not a schedule; the embed page lists at most six fields per record and keeps the
  session token in memory, so a reload needs a new host token.
- Guardrail rules drafted from a description (1.7.0, Sprint 41). The mark that sends an enforcing drafted rule through
  a second approver is kept by rule id: a guardrail admin who removes the rule and adds one of their own under another
  id has written a rule by hand, and it publishes as hand-written rules do (directly, for a tenant set). The drafting
  model sees the description only, not the rule set or its traffic, so it cannot judge false positives: the replay and
  the reviewers' decisions do. Draft quality depends on the profile's model and is not tested against a real one. A
  tenant with a single guardrail admin can draft, save and replay a rule but cannot make it enforce.
- **The tenant sign-in policy's reach (1.9.0, B-190).** The step-up window a tenant sets applies to the console's
  sensitive account changes (`requireRecentAuth`); creating a DAV or PDS app password still asks for a second factor
  within the platform's `STEPUP_WINDOW_SECONDS`. `exprsn-ai admin:create` and tenant templates check a first
  admin's password against the platform floor only (the tenant has no policy yet). The second-factor lockout
  (`mfa:<session>` keys) keeps the platform's settings. A forced expiry is measured from when the local password was
  last written (`local_credentials.updated_at`).
