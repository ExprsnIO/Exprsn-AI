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
- Lockout per account and per client address, shared across instances through the database.
- Second factors: TOTP with single use per time step and sealed seeds; WebAuthn passkeys with signature counters;
  recovery codes stored as HMACs. Admin roles require a verified factor for every admin request.

## Sessions and requests

- The browser holds only an opaque 256-bit token in a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`).
  The database stores its HMAC. Idle and absolute timeouts; the token is rotated when a second factor completes.
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

## Encryption at rest

Envelope encryption with a data key per tenant (and one for platform secrets such as TOTP seeds). Data keys are
random AES-256 keys stored only wrapped by a key-encryption key in the KMS: OpenBao/Vault transit, or locally a key
derived from `DATA_KEY`. Conversation titles, message content, thinking and calculation steps, attachments and export
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
- A profile carries a label: users need that clearance to pick it, and a conversation labelled above it cannot use
  it (the zone step of the policy). Pools carry a label ceiling, and requests are only routed to pools cleared for
  the conversation's label.
- Chat attachments are quarantined, type-checked from their bytes, scanned with ClamAV when configured, and
  classified for payment cards, IBANs, national identifiers, emails and phone numbers before a chat can use them;
  a file classified above its owner's clearance or the workspace ceiling is rejected.
- Model output is rendered as text in the console, never as HTML.

## Deployment hardening

Container: non-root, read-only root filesystem, all capabilities dropped, `no-new-privileges`, internal networks for
the database and Ollama. systemd: `ProtectSystem=strict`, `NoNewPrivileges`, empty capability set, system-call
filter, private `/tmp`, only the state directory writable.

## Known gaps, tracked in the plan

- First-factor enrolment: an admin with no second factor enrols one at first sign-in, so until then the account is
  protected by its password alone. Have new admins sign in and enrol promptly; an identity admin can reset factors
  (which forces re-enrolment) if an account may have been enrolled by someone else.
- Guardrails: while an answer streams, the deterministic `model-output` rules screen it sentence by sentence and the
  guard-model and classifier rules check the text so far in the background (Sprint 16). With
  `CHAT_GUARD_HOLDBACK_SENTENCES` ≥ 1 (the default) a sentence is shown only after a clean verdict covers it; with 0
  it is shown at once and a verdict can only stop what follows, so text the guard model would block can be shown and
  is replaced afterwards. A background check that cannot run stops release; the rest is shown after the full check.
  Thinking is screened like the answer, but the full check on the finished answer covers the answer text only. A
  phrase that spans a sentence boundary is blocked when its second half arrives, but the first half may have been
  shown. Tool results shown in chat pass the same screen (the model still receives them, checked at `context`). A
  `require-approval` on the prompt (`user-input`) holds it for a reviewer in chat; a hold that comes from a check that
  could not run still refuses the turn, and compare and `/v1` still refuse a held prompt.
- The trained classifier is a hashed-word linear head: its precision and recall are only as good as each tenant's
  labelled cases (the console warns below 200 per label).
- Knowledge: row-level permissions of source databases are not mapped to chunk access; a database source's chunks
  carry the connection's label and the knowledge base's access. Database sources sync by watermark on a schedule (no
  logical replication). A citation's passage is chosen by word overlap with the answer (the best-matching sentences of
  the chunk), not by the model saying what it quoted.
- Data connections: PostgreSQL, MySQL and OpenSearch; a username and password sealed with the tenant key, or (SQL
  engines) OpenBao dynamic database credentials. Dynamic leases are held per instance and revoked when a connection
  is removed, its credential changes, or the instance shuts down cleanly; an instance that dies leaves its lease to
  expire at its TTL. Writes through a connection are refused outright. Hosts must be internal unless
  `CONNECTIONS_ALLOWED_HOSTS` names them; a failed test still reports reachability for internal addresses. MySQL
  tables are not a knowledge source yet, and the MySQL classifier refuses vendor syntax it cannot lex safely rather
  than asking for confirmation.
- SQL user stores: the database host is checked before connecting, but the driver resolves the name again when it
  dials (LDAP stores and data connections dial the checked address). The connection string comes from a reference the
  operator allowed, which narrows the window to someone who controls that DNS name.
- With `REDIS_URL` set, rate limits, the failed-bearer throttle and the denial cap are shared by every instance; while
  Redis is unreachable (and without it) they are counted per instance, so a caller spread across N instances gets up
  to N times each limit. The failed-bearer throttle is per address: clients behind one NAT share it.
- Scripts need docker or podman on the host; with `SCRIPT_RUNNER=none`, or when no runtime answers, runs are refused.
  The sandbox relies on the container runtime's isolation (no gVisor or Firecracker).
- Tools: in chat, profiles offer only read-only tools that need no confirmation; write and destructive tools need an
  approval, which agent runs and workflows provide. MCP servers are checked against internal addresses after DNS
  resolution; hosts in `MCP_ALLOWED_HOSTS` (never link-local) are trusted by the operator. Tool results pass the
  `context` checkpoint (`meta.via: tool-result`) before the model sees them: a block withholds the result (the call
  itself has already run), a redaction replaces it. Agent runs propose memories only through the `remember` tool
  when their definition allows it; a model without tool calling cannot propose any.
- Workflows: the HTTP step may call any private address (narrowed by `WORKFLOW_HTTP_HOSTS` and by the tenant's
  allowed hosts when they are set). Run events go live only to the person who started the run; approvers see pending
  approvals through `GET /api/workflow-approvals` and the notification. A workflow published as a tool is pinned to one
  version, cannot be called from another workflow, and when it pauses for an approval its caller gets an error while
  the run continues on its own; a tool step's own approval pause has a fixed 24-hour timeout.
- Images and media frames are checked by the classifier at `IMAGE_SAFETY_URL`; without one, images are marked "not
  classified" rather than blocked.
- Resumable streams: an answer is marked interrupted only after `CHAT_STREAM_LEASE_SECONDS` without a heartbeat, and
  the stored text is the last snapshot (up to two seconds behind what clients saw). Continuing it relies on the
  model carrying on from an assistant prefill, which Ollama supports but a model may phrase imperfectly. An answer
  interrupted before its full `model-output` check ran shows what passed the streaming screen until it is continued
  or regenerated. Without Redis the catch-up buffer lives in the database; running several instances still needs Redis
  for the bus and the socket adapter.
- Conversation retention deletes conversations by last activity; the shortest of the tenant's, the workspace's and
  the owner's periods applies (Sprint 16). Periods are set by tenant admins; users cannot set their own. Usage
  records, audit events and flags that quote a purged answer are kept under their own rules.
- Training: the orchestrator sends the scrubbed rows of a dataset to the training worker in the submit request, so
  they are in plaintext in transit to it and on its scratch storage for the run; run the worker inside the training
  zone over TLS, with encrypted scratch that it clears after each run. Checkpoints and GGUF artefacts live in the
  worker's object store under its own keys, not the tenant's data keys. The draft model's GGUF is pulled by name from the registry the worker pushes to; the gateway does not import a
  GGUF file directly.
- Zones: rendered NetworkPolicy, Compose and nftables files are downloaded and deployed by an operator; the platform
  does not apply them itself (the Helm chart in Sprint 10 can consume them). MCP server and connection registration
  are refused in an undefined or external zone, or above its ceiling, only once zones are defined; members registered
  before that are reported on the Zones screen, not moved.
- Zones: seeding the default set is a single system-admin action (it can only add zones and never lowers what a zone
  holds); every later change needs a second system admin.
- Import bundles stream through verification and promotion (a 3 GiB bundle verifies with flat memory); S3 uploads
  use 16 MiB multipart parts, so one object is capped at about 160 GiB. Promotion writes into the mirror store in the blob store; pushing into Harbor, Verdaccio, devpi or the Trivy
  server is left to each mirror's own sync from `mirrors/<kind>/`.
- Without `PLATFORM_TRIVY_BIN` or `PLATFORM_STAGING_URL` the scan and staging steps are recorded as "not
  configured" and a bundle can still be promoted unless `PLATFORM_BUNDLE_REQUIRE_CHECKS` is set. Adding and revoking
  signer keys is under dual control, except the very first key, which one platform admin registers (as with the
  default zone set); revoking a compromised key therefore also waits for a second admin.
- ACME: http-01, or dns-01 through a signed webhook or RFC 2136 (TSIG) dynamic update; no ACME external account
  binding. RFC 2136 updates go over UDP to the primary only (no TCP fallback, no SOA lookup: the zone is configured).
  Issued certificates are written to `ACME_CERT_DIR` on every instance and announced on the bus, but the reverse proxy
  must watch the files (or be reloaded by the operator's tooling); services other than the proxy still take their key
  through the export.
- Backups cover the application database and the blob store; the KMS key material must be backed up with its own
  tooling, and a backup cannot be opened without the KMS key. The blob archive is taken after the database dump, not
  at the same instant: objects written in between may be in the archive without a row, or the other way round. The
  dump is logical (streamed, a page at a time); SQLite dumps are not taken inside one transaction. `backup:restore`
  restores into the configured database (tested on the engine the backup came from) with every instance stopped; it
  refuses a database with tenants, users or audit events unless forced with the confirmation phrase, and blob objects
  are written after the database commits. Tables outside the portable schema (`vectors_pg`) are skipped in the drill
  and rebuilt by reindexing.
- Clock skew is measured against the database server, and against NTP when `NTP_SERVER` is set: one unauthenticated
  SNTP query (no NTS), so a spoofed answer on the path could hide skew; it is a check, not a time source.
- Federation: the SAML IdP signs the assertion, not the whole response, with RSA-SHA256 only; SP metadata is pasted,
  never fetched. Upstream SAML accepts only exclusive C14N with RSA-SHA256 or ECDSA-SHA256 over SHA-256 digests and
  refuses IdP-initiated responses; upstream SAML's browser binding needs HTTPS (a `SameSite=None; Secure` cookie).
  Encrypted assertions use AES-GCM with RSA-OAEP only (CBC and RSA 1.5 are refused, so an IdP that only offers those
  must send them unencrypted).
- Logout: front-channel logout relies on the browser loading the relying parties' pages in frames with their own
  cookies, which browsers that block third-party cookies prevent; back-channel logout does not depend on the browser.
  Signing out in the console (`POST /api/auth/logout`) reaches back-channel clients only; front-channel frames and
  SP-initiated upstream SAML logout happen at `/oauth/logout`. SAML SPs that only take HTTP-POST single logout are not
  told when another SP or a relying party starts the sign-out (their sessions end at their own timeout).
  `prompt=login` and `max_age` re-authentication sign the current session out first, which also signs the user out of
  that session's other applications.
- DPoP: the server does not issue `DPoP-Nonce` values (RFC 9449 section 8 is optional), so a proof's freshness rests on
  `iat` within `DPOP_PROOF_MAX_AGE_SECONDS` and the single-use `jti`. The API checks `htu` against `PUBLIC_URL`, so a
  reverse proxy that serves the API under another origin or path prefix makes DPoP-bound calls fail.
- Token introspection answers only for tokens issued to the calling client; a separate resource server that needs to
  introspect other clients' tokens is not supported.
- Kerberos needs the optional `kerberos` npm module (GSSAPI bindings) and a keytab on the host; it is not bundled.
  Mapping takes the principal's user part and looks it up in the tenant's user stores; realms map to tenants only
  through the per-tenant realm allow-list.
- Signing keys: with `KMS_PROVIDER=local` the OIDC and SAML signing keys are sealed with the platform data key and
  held unsealed in memory while in use (with OpenBao they are signed in transit and never enter the process). The SAML
  SP decryption key for upstream encrypted assertions is always sealed locally, also with OpenBao (transit's RSA
  decryption does not offer the OAEP variants IdPs use). Turning on OpenBao replaces the signing keys at once: SAML
  service providers must re-import the IdP metadata for the new certificate.
- Key-encryption keys are re-wrapped with `kms:rewrap` (data keys, checkpoint signatures, backup archives and
  manifests). What else the KMS signed directly is not re-signed: image provenance HMACs inside PNG files and training
  model-card signatures made before the change stop verifying once the previous key is removed. OpenBao's own key
  versions are rotated and re-wrapped in OpenBao (`transit/keys/<name>/rotate`, `transit/rewrap`).
- Step-up (`STEPUP_WINDOW_SECONDS`) accepts the password only from accounts whose store checks passwords (local, LDAP,
  SQL); an account from an upstream OIDC or SAML provider with no second factor cannot step up and signs in again
  instead.
- The breached-password check is off by default (`BREACHED_PASSWORDS=off`): the range API is on the internet, so an
  air-gapped site needs an internal mirror or the offline file. When a source cannot be reached the password is
  accepted (fail open) and `password.breach_check.unavailable` is audited. Directory passwords (LDAP, SQL) are never
  checked here; the directory's own policy applies.
- A password reset request answers the same whether or not the account exists, but the server does a little more
  work (a token row and an email hand-off) when it does, so response time is not strictly constant. Reset and invite
  links need `SMTP_URL`. An admin password reset ends the account's sessions and OAuth grants but leaves its API keys,
  which are separate credentials (revoke them in the user's detail or by disabling the account).
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
  endpoint, so the endpoint must be trusted with them. Deliveries to one endpoint are not ordered, and receivers should
  de-duplicate by the event id (a replay reuses it). The signing secret is sealed at rest but is a shared secret, not a
  key pair. Endpoint names are resolved again when dialled; every address is checked in the dispatcher's lookup
  against the operator's rules and the tenant's list, as for MCP servers.
- Conversation sharing: readers of a user or workspace share can watch an answer stream (Sprint 16), answer text only
  (no thinking); a revocation or a label rising above them ends it at once, but a reader removed from a shared
  workspace keeps a watch already open until they reload or reconnect. Signed-in link shares open the transcript but
  do not stream. Anonymous links are off by default per tenant, open only conversations labelled `public` at that
  moment, expire within the tenant's limit (72 hours by default), are rate-limited per client address
  (`SHARE_ANONYMOUS_PER_MINUTE`, shared through Redis when set) and are audited with the address; anyone holding the
  link can read the conversation until then, and the address is only as reliable as the proxy settings.
- Billing: price books are platform-wide; there is no currency conversion, tax or proration, and a pushed Stripe invoice
  is not reconciled back (no inbound Stripe webhook). Statements are computed from `usage_records`, so usage deleted
  with a tenant's data is gone from later recomputations; push a finished month to keep it.
- Prompt templates pass the `user-input` checkpoint when they are saved and when a version is published (Sprint 16);
  a template published before a rule existed stays usable until it is published again, and the filled text still
  passes the checkpoint when it is sent.
- Pool instance, zone endpoint, connection and image backend URLs are chosen by operators and are not checked against
  internal or link-local addresses. Git sources refuse link-local hosts, but git's own DNS lookup is not pinned to the
  checked address.
- Media and image files are served with `Content-Security-Policy: sandbox` and `nosniff`; without `MEDIA_ORIGIN`
  they still come from the console's origin (sandboxed, so script in them cannot reach it). Signed media URLs are
  bearer URLs for their lifetime (`MEDIA_URL_TTL_SECONDS`).
- Security notices cover password, factor, recovery-code, API-key and session changes; a new sign-in does not send
  one. Email notices need `SMTP_URL` and an address on the account.
- Without `REDIS_URL`, rate limits are per instance (in memory); quotas are shared through the database.
